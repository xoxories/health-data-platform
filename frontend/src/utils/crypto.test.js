/**
 * Round-trip self-test for crypto.js.
 *
 * Run from the frontend/ directory:
 *
 *   node src/utils/crypto.test.js
 *
 * Uses Node 19+ built-in `crypto.subtle` / `crypto.getRandomValues` and
 * built-in `Blob` (since Node 18). No browser required.
 *
 * Note: the mock signer below is NOT a real ECDSA signer — it just
 * returns a deterministic 65-byte string. That's fine for THIS test,
 * which only verifies that the *round-trip* property of crypto.js holds.
 * The wallet's signing-key validity is the caller's concern at the
 * integration layer (Phase 2B/2C).
 */

import {
  generateAESKey,
  encryptFile,
  decryptFile,
  exportRawKey,
  importRawKey,
  deriveECIESKeypairFromSigner,
  wrapKeyForRecipient,
  unwrapKeyForSelf,
} from "./crypto.js";

// ---- assertions ----

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function pass(name) {
  console.log(`  ✓ ${name}`);
}

function fail(name, detail) {
  console.error(`  ✗ ${name}: ${detail}`);
  process.exitCode = 1;
  throw new Error(`${name}: ${detail}`);
}

// ---- mock signer ----
// Deterministic: signs always return the same 65 bytes for the same
// message. Sufficient for the round-trip property; the actual ECDSA
// behaviour is irrelevant because crypto.js just HKDFs the bytes.
const MOCK_SIGNATURE_HEX =
  "0x" +
  "11".repeat(32) +
  "22".repeat(32) +
  "1b"; // 65 bytes total

const mockSigner = {
  async signMessage(_msg) {
    return MOCK_SIGNATURE_HEX;
  },
};

// ---- main ----

async function main() {
  console.log("Round-trip test: frontend/src/utils/crypto.js");
  console.log("");

  // 1. Derive keypair.
  const { privateKey, publicKey } = await deriveECIESKeypairFromSigner(
    mockSigner
  );
  if (privateKey.length !== 32)
    fail("derived privateKey length", `expected 32, got ${privateKey.length}`);
  if (publicKey.length !== 33)
    fail("derived publicKey length", `expected 33, got ${publicKey.length}`);
  pass(`derived keypair (priv ${privateKey.length}B, pub ${publicKey.length}B)`);

  // Deterministic property: same input ⇒ same output.
  const again = await deriveECIESKeypairFromSigner(mockSigner);
  if (!bytesEqual(privateKey, again.privateKey))
    fail("deterministic priv", "second derivation differs");
  if (!bytesEqual(publicKey, again.publicKey))
    fail("deterministic pub", "second derivation differs");
  pass("keypair derivation is deterministic");

  // 2. Generate AES key.
  const aesKey = await generateAESKey();
  const rawAESKey = await exportRawKey(aesKey);
  if (rawAESKey.length !== 32)
    fail("raw AES key length", `expected 32, got ${rawAESKey.length}`);
  pass(`AES-256 key generated (${rawAESKey.length}B raw)`);

  // 3. Encrypt a sample blob.
  const plaintextText = "hello world";
  const plaintextBytes = new TextEncoder().encode(plaintextText);
  const fileLike = new Blob([plaintextBytes]);
  const { ciphertext, iv } = await encryptFile(fileLike, aesKey);
  if (iv.length !== 12)
    fail("iv length", `expected 12, got ${iv.length}`);
  if (ciphertext.length !== plaintextBytes.length + 16)
    fail(
      "ciphertext length",
      `expected ${plaintextBytes.length + 16}, got ${ciphertext.length}`
    );
  pass(`blob encrypted (ct ${ciphertext.length}B, iv ${iv.length}B)`);

  // 4. Wrap the AES key for the derived recipient.
  const wrapped = wrapKeyForRecipient(rawAESKey, publicKey);
  if (wrapped.length !== 93)
    fail("wrapped length", `expected 93, got ${wrapped.length}`);
  pass(`AES key wrapped (${wrapped.length}B envelope)`);

  // 5. Unwrap with the private key.
  const unwrapped = unwrapKeyForSelf(wrapped, privateKey);
  if (!bytesEqual(unwrapped, rawAESKey))
    fail("unwrapped", "key bytes differ from original");
  pass("unwrapped key matches original");

  // 6. Re-import and decrypt the blob using the unwrapped key.
  const reimported = await importRawKey(unwrapped);
  const decrypted = await decryptFile(ciphertext, reimported, iv);
  const decryptedText = new TextDecoder().decode(decrypted);

  // 7. Assert.
  if (decryptedText !== plaintextText)
    fail(
      "decrypted plaintext",
      `expected ${JSON.stringify(plaintextText)}, got ${JSON.stringify(
        decryptedText
      )}`
    );
  pass(`decrypted plaintext: ${JSON.stringify(decryptedText)}`);

  // Negative test: tampered envelope must fail authentication.
  const tampered = new Uint8Array(wrapped);
  tampered[60] ^= 0xff; // flip a byte in the ciphertext region
  let threw = false;
  try {
    unwrapKeyForSelf(tampered, privateKey);
  } catch {
    threw = true;
  }
  if (!threw) fail("tamper detection", "tampered envelope decrypted silently");
  pass("tampered envelope rejected (GCM auth)");

  // Negative test: wrong recipient cannot unwrap.
  const otherSigner = {
    async signMessage(_msg) {
      return (
        "0x" +
        "aa".repeat(32) +
        "bb".repeat(32) +
        "1c"
      );
    },
  };
  const otherKp = await deriveECIESKeypairFromSigner(otherSigner);
  threw = false;
  try {
    unwrapKeyForSelf(wrapped, otherKp.privateKey);
  } catch {
    threw = true;
  }
  if (!threw)
    fail("wrong-recipient rejection", "wrong privkey decrypted wrap");
  pass("wrong recipient cannot unwrap");

  // ---- Test 8: fresh AES-GCM IV on each encrypt ----
  // Catches a class of catastrophic bug: if encryptFile reused the same
  // IV with the same key, AES-GCM would leak the XOR of two plaintexts
  // and let an attacker recover the auth key.
  {
    const k = await generateAESKey();
    const blob = new TextEncoder().encode("same plaintext").buffer;
    const file = new File([blob], "t.txt");
    const a = await encryptFile(file, k);
    const b = await encryptFile(file, k);
    if (a.iv.every((byte, i) => byte === b.iv[i]))
      fail("Test 8 IVs", "two consecutive encryptFile calls produced identical IVs");
    if (a.ciphertext.every((byte, i) => byte === b.ciphertext[i]))
      fail(
        "Test 8 ciphertexts",
        "two consecutive encryptFile calls produced identical ciphertexts"
      );
    pass("fresh AES-GCM IV (and resulting ciphertext) on each encrypt");
  }

  // ---- Test 9: fresh ephemeral keypair on each wrap ----
  // Catches: if wrapKeyForRecipient reused the ephemeral private key,
  // every wrap would expose the same shared secret with the recipient,
  // letting an attacker correlate envelopes or recover earlier keys.
  {
    const { publicKey: testPubKey } = await deriveECIESKeypairFromSigner(
      mockSigner
    );
    const rawKey = new Uint8Array(32);
    crypto.getRandomValues(rawKey);
    const env1 = wrapKeyForRecipient(rawKey, testPubKey);
    const env2 = wrapKeyForRecipient(rawKey, testPubKey);
    const eph1 = env1.slice(0, 33);
    const eph2 = env2.slice(0, 33);
    if (eph1.every((byte, i) => byte === eph2[i]))
      fail(
        "Test 9 ephemeral pubkeys",
        "two consecutive wraps produced identical ephemeral pubkeys"
      );
    pass("fresh ephemeral keypair on each wrap");
  }

  console.log("");
  console.log("ROUND-TRIP: PASS");
}

main().catch((err) => {
  console.error("");
  console.error("ROUND-TRIP: FAIL");
  console.error(err);
  process.exit(1);
});
