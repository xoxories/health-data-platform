/**
 * Client-side encryption primitives for the Health Data Platform.
 *
 * Two layers:
 *
 *   1. File-level AES-256-GCM via WebCrypto. Each record is encrypted with a
 *      fresh symmetric key before being uploaded to IPFS.
 *
 *   2. ECIES over secp256k1 to wrap that symmetric key for a doctor
 *      recipient. We use the doctor's published encryption public key
 *      (see PatientRegistry.setDoctorEncryptionPubKey) to derive a shared
 *      secret with an ephemeral key, then AES-GCM-encrypt the AES key with
 *      an HKDF-derived wrap key.
 *
 * AES-GCM file ops use WebCrypto (built-in, well-vetted). ECIES inner
 * AES-GCM uses @noble/ciphers because it's synchronous and the buffers are
 * tiny, which keeps the wrap/unwrap callsites simpler.
 */

// @noble/curves and @noble/hashes v2.x require explicit `.js` subpath
// specifiers per their strict `exports` maps. Vite and Node both honour
// this — bare `@noble/curves/secp256k1` will fail with ERR_PACKAGE_PATH_NOT_EXPORTED.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const ENCODER = new TextEncoder();

/// The message the wallet signs to derive an encryption keypair.
/// Versioned so we can rotate the derivation later without breaking
/// existing wrappings.
const KEYPAIR_SIG_MESSAGE = "HealthDataPlatform key derivation v1";

/// HKDF salt/info for keypair derivation.
const KEYPAIR_SALT = ENCODER.encode("HDP-ECIES-v1");
const KEYPAIR_INFO = ENCODER.encode("secp256k1-keypair");

/// HKDF salt/info for the per-wrap key derivation from the ECDH shared
/// secret. Independent context strings so the keypair derivation and the
/// wrap key derivation can never collide.
const WRAP_SALT = ENCODER.encode("HDP-wrap-v1");
const WRAP_INFO = ENCODER.encode("aes-key-wrap");

/// Standard AES-GCM IV length, in bytes (NIST SP 800-38D recommendation).
const AES_IV_LENGTH = 12;

/// AES-256 raw key length, in bytes.
const AES_KEY_LENGTH = 32;

/// AES-GCM authentication tag length, in bytes (max for AES-GCM).
const AES_TAG_LENGTH = 16;

/// secp256k1 compressed-point encoding length, in bytes (1 prefix + 32 x).
const SECP256K1_COMPRESSED_LENGTH = 33;

/// Total wrapped-key envelope size:
///   [ephemeralPub (33) || iv (12) || (ciphertext + tag) (32 + 16)] = 93 bytes
const WRAPPED_KEY_LENGTH =
  SECP256K1_COMPRESSED_LENGTH + AES_IV_LENGTH + AES_KEY_LENGTH + AES_TAG_LENGTH;

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

function assertU8(value, expectedLen, name) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Uint8Array`);
  }
  if (typeof expectedLen === "number" && value.length !== expectedLen) {
    throw new RangeError(
      `${name} must be ${expectedLen} bytes (got ${value.length})`
    );
  }
}

function hexToBytes(hex) {
  const clean =
    hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error("Hex string has odd length");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBigIntBE(bytes) {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

function bigIntToBytesBE(value, length) {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function concatU8(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------
// AES-GCM file encryption (WebCrypto)
// ---------------------------------------------------------------------

/**
 * Generate a fresh AES-GCM-256 CryptoKey. Extractable so we can wrap it
 * for recipients later.
 */
export async function generateAESKey() {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    /* extractable */ true,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt a File (or Blob — anything with .arrayBuffer()) under AES-GCM
 * with a fresh 12-byte random IV.
 *
 * @returns {Promise<{ ciphertext: Uint8Array, iv: Uint8Array }>}
 */
export async function encryptFile(file, key) {
  if (typeof file?.arrayBuffer !== "function") {
    throw new TypeError("encryptFile: 'file' must be a File or Blob");
  }
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH));
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );
  return { ciphertext: new Uint8Array(ciphertextBuf), iv };
}

/**
 * Decrypt a ciphertext previously produced by {@link encryptFile}.
 *
 * @returns {Promise<Uint8Array>} the plaintext bytes
 */
export async function decryptFile(ciphertext, key, iv) {
  assertU8(ciphertext, undefined, "ciphertext");
  assertU8(iv, AES_IV_LENGTH, "iv");
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return new Uint8Array(plaintextBuf);
}

/**
 * Export an AES-GCM CryptoKey to its raw 32-byte form. Used to feed the
 * key into the ECIES wrap.
 */
export async function exportRawKey(key) {
  const buf = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(buf);
}

/**
 * Import a 32-byte raw AES-GCM key as a CryptoKey suitable for decrypt.
 */
export async function importRawKey(raw) {
  assertU8(raw, AES_KEY_LENGTH, "raw");
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    /* extractable */ true,
    ["encrypt", "decrypt"]
  );
}

// ---------------------------------------------------------------------
// ECIES keypair derivation from a wallet signer
// ---------------------------------------------------------------------

/**
 * Derive a deterministic secp256k1 encryption keypair from a wallet
 * signer.
 *
 * MetaMask never exposes the wallet's signing private key, but it CAN
 * produce ECDSA signatures over arbitrary messages. We have the wallet
 * sign a fixed, versioned message; because ECDSA over the same key and
 * the same message yields a (deterministically-derived for our purposes)
 * signature, we then HKDF those signature bytes into a fresh 32-byte
 * scalar and treat it as our encryption private key.
 *
 * This means:
 *   - The encryption keypair is deterministic per wallet — the same
 *     wallet always derives the same keypair, so they can decrypt
 *     anything previously wrapped for them.
 *   - The keypair is independent of the wallet's signing key; leaking
 *     one does not leak the other.
 *   - There is no on-chain storage of the private key.
 *
 * @param signer Any object with `signMessage(msg: string) => Promise<string>`,
 *               e.g. an ethers.js Signer.
 * @returns {Promise<{ privateKey: Uint8Array, publicKey: Uint8Array }>}
 *          privateKey is 32 bytes; publicKey is 33 bytes compressed
 *          (0x02/0x03 prefix + 32 bytes x-coordinate).
 */
export async function deriveECIESKeypairFromSigner(signer) {
  if (typeof signer?.signMessage !== "function") {
    throw new TypeError(
      "deriveECIESKeypairFromSigner: signer.signMessage missing"
    );
  }
  const signature = await signer.signMessage(KEYPAIR_SIG_MESSAGE);
  if (typeof signature !== "string") {
    throw new Error("signer.signMessage must return a hex string");
  }
  const sigBytes = hexToBytes(signature);

  // HKDF the signature bytes down to 32 bytes of keying material.
  const ikm = hkdf(sha256, sigBytes, KEYPAIR_SALT, KEYPAIR_INFO, 32);

  // Reduce modulo the curve order so the result is a valid secp256k1
  // scalar. The probability of needing reduction (ikm >= n) is ~2^-128,
  // so this is essentially always a no-op — kept for safety / specs.
  // (Curve order in @noble/curves v2 lives at Point.Fn.ORDER, not CURVE.n.)
  const n = secp256k1.Point.Fn.ORDER;
  let scalar = bytesToBigIntBE(ikm) % n;
  if (scalar === 0n) scalar = 1n; // also vanishingly improbable

  const privateKey = bigIntToBytesBE(scalar, 32);
  const publicKey = secp256k1.getPublicKey(privateKey, /* compressed */ true);
  return { privateKey, publicKey };
}

// ---------------------------------------------------------------------
// ECIES wrap / unwrap
// ---------------------------------------------------------------------

/**
 * Wrap a 32-byte AES key so that only the holder of the secp256k1
 * private key matching `recipientCompressedPubKey` can recover it.
 *
 * Envelope layout (93 bytes total):
 *
 *   bytes  0..33   ephemeral public key (compressed, 33 bytes)
 *   bytes 33..45   AES-GCM IV (12 bytes, random)
 *   bytes 45..93   AES-GCM ciphertext + auth tag (32 + 16 = 48 bytes)
 *
 * @param rawAESKey 32-byte symmetric key to be wrapped.
 * @param recipientCompressedPubKey 33-byte compressed secp256k1 pubkey.
 * @returns {Uint8Array} 93-byte wrapped-key envelope.
 */
export function wrapKeyForRecipient(rawAESKey, recipientCompressedPubKey) {
  assertU8(rawAESKey, AES_KEY_LENGTH, "rawAESKey");
  assertU8(
    recipientCompressedPubKey,
    SECP256K1_COMPRESSED_LENGTH,
    "recipientCompressedPubKey"
  );

  // 1. Fresh ephemeral keypair. (Renamed from randomPrivateKey → randomSecretKey in @noble/curves v2.)
  const ephemeralPriv = secp256k1.utils.randomSecretKey();
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, true); // 33 bytes

  // 2. ECDH: shared = ephemeralPriv * recipientPub. Returned as a
  //    compressed point (1 prefix byte + 32 x bytes). Take the x as
  //    the shared secret input to the KDF.
  const sharedPoint = secp256k1.getSharedSecret(
    ephemeralPriv,
    recipientCompressedPubKey
  );
  const sharedX = sharedPoint.slice(1, 1 + 32);

  // 3. KDF.
  const wrapKey = hkdf(sha256, sharedX, WRAP_SALT, WRAP_INFO, AES_KEY_LENGTH);

  // 4. AES-256-GCM encrypt the AES key.
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH));
  const ciphertextAndTag = gcm(wrapKey, iv).encrypt(rawAESKey);

  // 5. Assemble [E || iv || ct+tag].
  return concatU8(ephemeralPub, iv, ciphertextAndTag);
}

/**
 * Recover the 32-byte AES key from a wrap previously produced by
 * {@link wrapKeyForRecipient}.
 *
 * @param wrapped 93-byte wrapped-key envelope.
 * @param myPrivateKey 32-byte secp256k1 private key (the one matching
 *                     the `recipientCompressedPubKey` used at wrap time).
 * @returns {Uint8Array} 32-byte raw AES key.
 * @throws if authentication fails (tampered wrap or wrong key).
 */
export function unwrapKeyForSelf(wrapped, myPrivateKey) {
  assertU8(wrapped, WRAPPED_KEY_LENGTH, "wrapped");
  assertU8(myPrivateKey, AES_KEY_LENGTH, "myPrivateKey");

  const ephemeralPub = wrapped.slice(0, SECP256K1_COMPRESSED_LENGTH);
  const iv = wrapped.slice(
    SECP256K1_COMPRESSED_LENGTH,
    SECP256K1_COMPRESSED_LENGTH + AES_IV_LENGTH
  );
  const ciphertextAndTag = wrapped.slice(
    SECP256K1_COMPRESSED_LENGTH + AES_IV_LENGTH
  );

  const sharedPoint = secp256k1.getSharedSecret(myPrivateKey, ephemeralPub);
  const sharedX = sharedPoint.slice(1, 1 + 32);
  const wrapKey = hkdf(sha256, sharedX, WRAP_SALT, WRAP_INFO, AES_KEY_LENGTH);

  const plaintext = gcm(wrapKey, iv).decrypt(ciphertextAndTag);
  if (plaintext.length !== AES_KEY_LENGTH) {
    throw new Error("unwrapKeyForSelf: unexpected plaintext length");
  }
  return plaintext;
}

// ---------------------------------------------------------------------
// Per-category record bundles (Phase 2C)
// ---------------------------------------------------------------------
//
// The smart contract stores ONE bytes blob per (patient, doctor, category)
// in `doctorWrappedKeys[patient][doctor][category]`. But the upload flow
// (Phase 2B) generates a fresh AES key per record, so we need to fit N
// per-record wraps into that single category-level blob. We pack them as:
//
//   byte  0          uint8 N      (entry count)
//   bytes 1..(1+N*125)   N entries, each:
//     bytes 0..32   uint256 recordId (big-endian)
//     bytes 32..125 93-byte ECIES envelope (doctor-wrapped per-record AES key)
//
// At view time, the doctor receives the whole bundle from
// HealthRecordStorage.getRecordForDoctor, looks up the entry whose
// recordId matches the one being read, and unwraps just that entry.
//
// Bundle size cap: contract enforces 2048-byte MAX_WRAPPED_KEY_LENGTH.
//   1 + N*125 <= 2048  ⇒  N <= 16
// So at most 16 records can be granted per category in one grant call. If
// a patient later adds more records to an already-consented category,
// they must re-grant to refresh the bundle.

/// Per-entry binary size in {bundleWrappedKeys} format (32 bytes recordId
/// + 93 bytes wrapped envelope).
export const BUNDLE_ENTRY_BYTES = 32 + WRAPPED_KEY_LENGTH;

/// Maximum entries that fit within the contract's 2048-byte cap:
///   1 + N * 125 <= 2048  ⇒  N <= 16
export const BUNDLE_MAX_ENTRIES = 16;

/**
 * Serialise an array of (recordId, wrapped) entries into the single
 * category-level blob format documented above.
 *
 * @param {Array<{recordId: bigint, wrapped: Uint8Array}>} entries
 * @returns {Uint8Array}
 * @throws if entries exceed {BUNDLE_MAX_ENTRIES} or any wrap is wrong size.
 */
export function bundleWrappedKeys(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("bundleWrappedKeys: entries must be an array");
  }
  if (entries.length === 0) {
    throw new RangeError(
      "bundleWrappedKeys: at least one entry required (contract rejects empty wrappedKey)"
    );
  }
  if (entries.length > BUNDLE_MAX_ENTRIES) {
    throw new RangeError(
      `bundleWrappedKeys: too many entries (${entries.length} > ${BUNDLE_MAX_ENTRIES}) — contract limit is 2048 bytes per category bundle`
    );
  }

  const out = new Uint8Array(1 + entries.length * BUNDLE_ENTRY_BYTES);
  out[0] = entries.length;

  for (let i = 0; i < entries.length; i++) {
    const { recordId, wrapped } = entries[i];
    if (typeof recordId !== "bigint") {
      throw new TypeError(
        `bundleWrappedKeys: entry[${i}].recordId must be a bigint`
      );
    }
    assertU8(wrapped, WRAPPED_KEY_LENGTH, `entry[${i}].wrapped`);

    const offset = 1 + i * BUNDLE_ENTRY_BYTES;
    out.set(bigIntToBytesBE(recordId, 32), offset);
    out.set(wrapped, offset + 32);
  }

  return out;
}

/**
 * Parse a category-level bundle back into its constituent
 * (recordId, wrapped) entries.
 *
 * @param {Uint8Array} bytes
 * @returns {Array<{recordId: bigint, wrapped: Uint8Array}>}
 * @throws if the byte length doesn't match the declared entry count.
 */
export function unbundleWrappedKeys(bytes) {
  assertU8(bytes, undefined, "bytes");
  if (bytes.length === 0) {
    throw new Error("unbundleWrappedKeys: empty bundle");
  }
  const count = bytes[0];
  const expectedLen = 1 + count * BUNDLE_ENTRY_BYTES;
  if (bytes.length !== expectedLen) {
    throw new Error(
      `unbundleWrappedKeys: length mismatch — header says ${count} entries (${expectedLen} bytes) but blob is ${bytes.length} bytes`
    );
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    const offset = 1 + i * BUNDLE_ENTRY_BYTES;
    const recordIdBytes = bytes.slice(offset, offset + 32);
    const wrapped = bytes.slice(offset + 32, offset + 32 + WRAPPED_KEY_LENGTH);
    entries.push({
      recordId: bytesToBigIntBE(recordIdBytes),
      wrapped,
    });
  }
  return entries;
}

/**
 * Convert a 33-byte compressed secp256k1 pubkey to the 64-byte
 * uncompressed form (x ‖ y, no leading 0x04 prefix byte) expected by
 * PatientRegistry.setDoctorEncryptionPubKey. Inverse of the prefix
 * derivation used at the contract boundary.
 *
 * @param {Uint8Array} compressed33
 * @returns {Uint8Array} 64-byte x || y, no prefix.
 */
export function uncompressPubKey(compressed33) {
  assertU8(compressed33, SECP256K1_COMPRESSED_LENGTH, "compressed33");
  const point = secp256k1.Point.fromBytes(compressed33);
  const uncompressed = point.toBytes(false); // 65 bytes: 0x04 || x || y
  return uncompressed.slice(1);
}

/**
 * Convenience: parse a bundle and return only the entry matching a
 * specific recordId. Throws if not found.
 *
 * @param {Uint8Array} bundle
 * @param {bigint} recordId
 * @returns {Uint8Array} the 93-byte wrap for that record.
 */
export function findWrappedKeyForRecord(bundle, recordId) {
  if (typeof recordId !== "bigint") {
    throw new TypeError("findWrappedKeyForRecord: recordId must be a bigint");
  }
  const entries = unbundleWrappedKeys(bundle);
  const hit = entries.find((e) => e.recordId === recordId);
  if (!hit) {
    throw new Error(
      `findWrappedKeyForRecord: no entry for recordId ${recordId.toString()} in bundle of ${
        entries.length
      } entries`
    );
  }
  return hit.wrapped;
}
