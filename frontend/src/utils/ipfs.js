import axios from "axios";

import {
  generateAESKey,
  encryptFile,
  exportRawKey,
  deriveECIESKeypairFromSigner,
  wrapKeyForRecipient,
} from "./crypto.js";

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------
//
// Note on the SDK choice: this module talks to Pinata's REST API directly
// rather than via `@pinata/sdk`. The `@pinata/sdk` package is Node-only
// (depends on `fs` and `form-data` internals) and fails to bundle / run in
// a Vite browser app. The HTTP endpoint we hit here is the same one the
// SDK ultimately calls, so behaviour is equivalent.

const PINATA_API_KEY = import.meta.env.VITE_PINATA_API_KEY || "";
const PINATA_API_SECRET = import.meta.env.VITE_PINATA_API_SECRET || "";

const PINATA_PIN_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PINATA_GATEWAY = "https://gateway.pinata.cloud/ipfs";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function authHeaders() {
  if (!PINATA_API_KEY || !PINATA_API_SECRET) {
    throw new Error(
      "Pinata credentials are not configured. Set VITE_PINATA_API_KEY and VITE_PINATA_API_SECRET in frontend/.env."
    );
  }
  return {
    pinata_api_key: PINATA_API_KEY,
    pinata_secret_api_key: PINATA_API_SECRET,
  };
}

function describeUploadError(err) {
  if (err?.response) {
    const { status, statusText, data } = err.response;
    const detail =
      data?.error?.details ||
      data?.error ||
      data?.message ||
      statusText ||
      "request failed";
    return `Pinata responded ${status}: ${
      typeof detail === "string" ? detail : JSON.stringify(detail)
    }`;
  }
  return err?.message || "Unknown error";
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Upload a file to IPFS via Pinata's pinFileToIPFS endpoint.
 *
 * @param {File|Blob} file        The file or blob to upload.
 * @param {object}    [metadata]  Optional Pinata metadata. Either a flat
 *                                object (used as keyvalues) or
 *                                `{ name, keyvalues }`.
 * @returns {Promise<string>}     The IPFS CID (Pinata's `IpfsHash`).
 * @throws {Error}                Descriptive error if the upload fails.
 */
export async function uploadToIPFS(file, metadata) {
  if (!file) {
    throw new Error("uploadToIPFS: a File or Blob is required.");
  }

  const formData = new FormData();
  formData.append("file", file);

  if (metadata) {
    // Pinata expects: { name: string, keyvalues: object }.
    // Accept either that exact shape, or a flat object treated as keyvalues.
    const hasShape =
      Object.prototype.hasOwnProperty.call(metadata, "name") ||
      Object.prototype.hasOwnProperty.call(metadata, "keyvalues");

    const pinataMetadata = hasShape
      ? {
          name: metadata.name || file.name || "untitled",
          ...(metadata.keyvalues ? { keyvalues: metadata.keyvalues } : {}),
        }
      : {
          name: file.name || "untitled",
          keyvalues: metadata,
        };

    formData.append("pinataMetadata", JSON.stringify(pinataMetadata));
  }

  try {
    const res = await axios.post(PINATA_PIN_FILE_URL, formData, {
      maxBodyLength: Infinity,
      headers: {
        "Content-Type": "multipart/form-data",
        ...authHeaders(),
      },
    });

    const cid = res?.data?.IpfsHash;
    if (!cid) {
      throw new Error(
        "Pinata response did not include IpfsHash. Full response: " +
          JSON.stringify(res?.data)
      );
    }

    console.log("[ipfs] Uploaded to IPFS. CID:", cid);
    return cid;
  } catch (err) {
    const detail = describeUploadError(err);
    console.error("[ipfs] uploadToIPFS failed:", err);
    throw new Error(`Failed to upload to IPFS — ${detail}`);
  }
}

/**
 * End-to-end encrypted upload helper.
 *
 *   1. Generates a fresh AES-256-GCM key.
 *   2. Encrypts the file under that key.
 *   3. Builds the IPFS payload as [iv (12 bytes) || ciphertext+tag].
 *   4. Uploads via the existing {@link uploadToIPFS} helper (reuses the
 *      Pinata auth + error-handling logic; no duplicated upload code).
 *   5. Wraps the AES key under the patient's OWN ECIES pubkey, derived
 *      deterministically from `signer`.
 *
 * The returned `encryptedKey` is the 93-byte ECIES envelope ready to
 * pass straight to `HealthRecordStorage.storeRecord` as the `bytes
 * encryptedKey` field. The patient (the same signer) can later re-derive
 * their keypair and unwrap the AES key when they want to re-wrap it for
 * a doctor in ConsentManager.grantAccess.
 *
 * @param {File|Blob} plainFile        Source file to encrypt + upload.
 * @param {Uint8Array} [recipientPubKey] RESERVED for future direct-share
 *                     flows; unused in v1. If provided, a warning is
 *                     logged and the parameter is otherwise ignored.
 * @param {object} signer              Anything with `signMessage(msg)`,
 *                     e.g. an ethers.js Signer. Used ONLY to derive the
 *                     patient's encryption keypair.
 * @param {(phase: string) => void} [onProgress] Optional callback fired
 *                     at phase boundaries: `"encrypting"`, `"uploading"`,
 *                     `"wrapping"`, `"done"`. Lets the caller drive a
 *                     fine-grained status indicator.
 * @returns {Promise<{ cid: string, encryptedKey: Uint8Array, iv: Uint8Array }>}
 *          cid          — IPFS CID for the IV-prefixed ciphertext payload.
 *          encryptedKey — 93-byte patient-wrapped ECIES envelope. Pass to
 *                         HealthRecordStorage.storeRecord directly.
 *          iv           — The AES-GCM IV (also stored as the first 12
 *                         bytes of the IPFS payload; returned for caller
 *                         convenience).
 */
export async function uploadEncrypted(
  plainFile,
  recipientPubKey,
  signer,
  onProgress,
  precomputedKeypair
) {
  if (!plainFile || typeof plainFile.arrayBuffer !== "function") {
    throw new Error("uploadEncrypted: plainFile must be a File or Blob.");
  }
  if (recipientPubKey) {
    // Loud so we notice when the future direct-share path gets wired up.
    console.warn(
      "[ipfs] uploadEncrypted: recipientPubKey is RESERVED in v1 and was ignored."
    );
  }

  // The caller can pass a `precomputedKeypair` to skip the MetaMask
  // signature prompt — useful when the dashboard has already derived
  // the patient's keypair earlier in the session and cached it. Without
  // this, every upload triggers a fresh signature prompt even though
  // the canonical message is fixed and the signature is deterministic.
  let patientPubKey;
  if (precomputedKeypair?.publicKey) {
    patientPubKey = precomputedKeypair.publicKey;
  } else {
    if (!signer || typeof signer.signMessage !== "function") {
      throw new Error(
        "uploadEncrypted: signer must support signMessage() (or pass precomputedKeypair)."
      );
    }
    const kp = await deriveECIESKeypairFromSigner(signer);
    patientPubKey = kp.publicKey;
  }

  // ---- Step 1: generate fresh AES key ----
  onProgress?.("encrypting");
  const aesKey = await generateAESKey();

  // ---- Step 2: encrypt the file ----
  const { ciphertext, iv } = await encryptFile(plainFile, aesKey);

  // ---- Step 3: build [iv || ciphertext+tag] payload, wrap in File ----
  const payload = new Uint8Array(iv.length + ciphertext.length);
  payload.set(iv, 0);
  payload.set(ciphertext, iv.length);

  const baseName =
    typeof plainFile.name === "string" && plainFile.name.length > 0
      ? plainFile.name
      : "record";
  const encFile = new File([payload], `${baseName}.enc`, {
    type: "application/octet-stream",
  });

  // ---- Step 4: upload via the existing helper (re-uses auth) ----
  onProgress?.("uploading");
  const cid = await uploadToIPFS(encFile);

  // ---- Step 5: export AES key for wrapping ----
  onProgress?.("wrapping");
  const rawAESKey = await exportRawKey(aesKey);

  // ---- Step 6: wrap the AES key under the patient's own pubkey ----
  const encryptedKey = wrapKeyForRecipient(rawAESKey, patientPubKey);

  onProgress?.("done");
  return { cid, encryptedKey, iv };
}

/**
 * Fetch an encrypted IPFS payload as bytes.
 *
 * Tries `VITE_PINATA_GATEWAY` first if configured, then the Pinata
 * public gateway, then the ipfs.io public gateway. Returns the raw
 * Uint8Array contents on first 2xx.
 *
 * @param {string} cid The IPFS CID to fetch.
 * @returns {Promise<Uint8Array>}
 * @throws {Error} with message including the CID and the last HTTP
 *         status / network detail if every gateway fails.
 */
export async function fetchEncrypted(cid) {
  if (!cid || typeof cid !== "string") {
    throw new Error("fetchEncrypted: cid is required.");
  }

  const configured = import.meta.env.VITE_PINATA_GATEWAY;
  const gateways = [];
  if (configured) {
    // Strip any trailing slash; we'll add our own.
    gateways.push(configured.replace(/\/+$/, ""));
  }
  // Default Pinata + IPFS public gateways as fallbacks.
  gateways.push("https://gateway.pinata.cloud/ipfs");
  gateways.push("https://ipfs.io/ipfs");

  const failures = [];
  for (const base of gateways) {
    const url = `${base}/${cid}`;
    let response;
    try {
      response = await fetch(url);
    } catch (err) {
      failures.push(`${url}: ${err?.message || "network error"}`);
      continue;
    }
    if (!response.ok) {
      failures.push(`${url}: HTTP ${response.status} ${response.statusText}`);
      continue;
    }
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }

  throw new Error(
    `Failed to fetch from IPFS — cid=${cid}. Tried:\n  ${failures.join("\n  ")}`
  );
}

/**
 * Build a public Pinata gateway URL for a given IPFS CID.
 * @param {string} cid
 * @returns {string}
 */
export function getIPFSUrl(cid) {
  if (!cid) return "";
  return `${PINATA_GATEWAY}/${cid}`;
}

/**
 * Fetch a file from IPFS via the Pinata gateway.
 *
 * @param {string} cid          The IPFS CID to retrieve.
 * @returns {Promise<Response>} The raw fetch Response. Use `.blob()`,
 *                              `.json()`, `.text()`, etc. on the caller.
 * @throws {Error}              Descriptive error on network or HTTP failure.
 */
export async function fetchFromIPFS(cid) {
  if (!cid) {
    throw new Error("fetchFromIPFS: cid is required.");
  }

  let response;
  try {
    response = await fetch(getIPFSUrl(cid));
  } catch (err) {
    throw new Error(
      `Failed to fetch from IPFS — network error: ${err.message || err}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch from IPFS — HTTP ${response.status} ${response.statusText}`
    );
  }

  return response;
}
