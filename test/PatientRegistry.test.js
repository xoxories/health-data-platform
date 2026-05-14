const { expect } = require("chai");
const { ethers } = require("hardhat");

// Sample test fixtures.
const LICENSE_HASH = ethers.keccak256(ethers.toUtf8Bytes("MD-12345-CARDIO"));
const HOSPITAL = "General Hospital";

/**
 * Returns the timestamp of the block in which `tx` was mined.
 */
async function txBlockTimestamp(tx) {
  const receipt = await tx.wait();
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  return block.timestamp;
}

describe("PatientRegistry", function () {
  let patientRegistry;
  let owner; // accounts[0]
  let patient; // accounts[1]
  let doctor; // accounts[2]
  let other; // accounts[3]

  beforeEach(async function () {
    [owner, patient, doctor, other] = await ethers.getSigners();
    const PatientRegistry = await ethers.getContractFactory("PatientRegistry");
    patientRegistry = await PatientRegistry.deploy();
    await patientRegistry.waitForDeployment();
  });

  // -----------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------

  describe("Happy path", function () {
    it("should allow a new address to register as a patient with a name", async function () {
      await patientRegistry.connect(patient).registerPatient("Alice");
      expect(await patientRegistry.isPatient(patient.address)).to.equal(true);
    });

    it("should emit PatientRegistered event with correct args on registration", async function () {
      const tx = await patientRegistry
        .connect(patient)
        .registerPatient("Alice");
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(patientRegistry, "PatientRegistered")
        .withArgs(patient.address, "Alice", ts);
    });

    it("should store the patient name and timestamp correctly", async function () {
      const tx = await patientRegistry
        .connect(patient)
        .registerPatient("Alice");
      const ts = await txBlockTimestamp(tx);

      const stored = await patientRegistry.getPatient(patient.address);
      expect(stored.name).to.equal("Alice");
      expect(stored.isRegistered).to.equal(true);
      expect(stored.registeredAt).to.equal(ts);
    });

    it("should allow owner to register a doctor with licenseHash and hospitalAffiliation", async function () {
      await patientRegistry
        .connect(owner)
        .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL);

      expect(await patientRegistry.isDoctor(doctor.address)).to.equal(true);

      const stored = await patientRegistry.getDoctor(doctor.address);
      expect(stored.licenseHash).to.equal(LICENSE_HASH);
      expect(stored.hospitalAffiliation).to.equal(HOSPITAL);
      expect(stored.isActive).to.equal(true);
    });

    it("should emit DoctorRegistered event with correct args", async function () {
      const tx = await patientRegistry
        .connect(owner)
        .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL);
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(patientRegistry, "DoctorRegistered")
        .withArgs(doctor.address, LICENSE_HASH, HOSPITAL, ts);
    });

    it("isPatient() should return true for registered, false for unregistered", async function () {
      expect(await patientRegistry.isPatient(patient.address)).to.equal(false);
      await patientRegistry.connect(patient).registerPatient("Alice");
      expect(await patientRegistry.isPatient(patient.address)).to.equal(true);
      expect(await patientRegistry.isPatient(other.address)).to.equal(false);
    });

    it("isDoctor() should return true for registered, false for unregistered", async function () {
      expect(await patientRegistry.isDoctor(doctor.address)).to.equal(false);
      await patientRegistry
        .connect(owner)
        .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL);
      expect(await patientRegistry.isDoctor(doctor.address)).to.equal(true);
      expect(await patientRegistry.isDoctor(other.address)).to.equal(false);
    });

    it("getDoctorInfo() returns the correct destructured tuple", async function () {
      const tx = await patientRegistry
        .connect(owner)
        .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL);
      const ts = await txBlockTimestamp(tx);

      const [licenseHash, hospital, isActive, registeredAt, encryptionPubKey] =
        await patientRegistry.getDoctorInfo(doctor.address);

      expect(licenseHash).to.equal(LICENSE_HASH);
      expect(hospital).to.equal(HOSPITAL);
      expect(isActive).to.equal(true);
      expect(registeredAt).to.equal(ts);
      // Doctor hasn't published their pubkey yet.
      expect(encryptionPubKey).to.equal("0x");
    });
  });

  // -----------------------------------------------------------------
  // Access control / revert cases
  // -----------------------------------------------------------------

  describe("Access control / revert cases", function () {
    it("should revert if same address tries to register as patient twice", async function () {
      await patientRegistry.connect(patient).registerPatient("Alice");
      await expect(
        patientRegistry.connect(patient).registerPatient("Alice")
      ).to.be.revertedWith("PatientRegistry: already registered as patient");
    });

    it("should revert if non-owner tries to register a doctor", async function () {
      await expect(
        patientRegistry
          .connect(patient)
          .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL)
      )
        .to.be.revertedWithCustomError(
          patientRegistry,
          "OwnableUnauthorizedAccount"
        )
        .withArgs(patient.address);
    });

    it("should allow owner to revoke a doctor with a reason", async function () {
      await patientRegistry
        .connect(owner)
        .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL);

      const reason = "License expired";
      const tx = await patientRegistry
        .connect(owner)
        .revokeDoctor(doctor.address, reason);
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(patientRegistry, "DoctorRevoked")
        .withArgs(doctor.address, reason, ts);

      const stored = await patientRegistry.getDoctor(doctor.address);
      expect(stored.isActive).to.equal(false);
    });

    it("isDoctor() should return false after revocation", async function () {
      await patientRegistry
        .connect(owner)
        .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL);
      expect(await patientRegistry.isDoctor(doctor.address)).to.equal(true);

      await patientRegistry
        .connect(owner)
        .revokeDoctor(doctor.address, "Routine cleanup");
      expect(await patientRegistry.isDoctor(doctor.address)).to.equal(false);
    });

    it("should revert if trying to revoke an address that is not a doctor", async function () {
      await expect(
        patientRegistry
          .connect(owner)
          .revokeDoctor(other.address, "noop")
      ).to.be.revertedWith("PatientRegistry: doctor not active");
    });

    it("should revert if non-owner tries to revoke a doctor", async function () {
      await patientRegistry
        .connect(owner)
        .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL);

      await expect(
        patientRegistry
          .connect(patient)
          .revokeDoctor(doctor.address, "unauthorised")
      )
        .to.be.revertedWithCustomError(
          patientRegistry,
          "OwnableUnauthorizedAccount"
        )
        .withArgs(patient.address);
    });
  });

  // -----------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------

  describe("Edge cases", function () {
    it("should revert if patient name is an empty string", async function () {
      await expect(
        patientRegistry.connect(patient).registerPatient("")
      ).to.be.revertedWith("PatientRegistry: name required");
    });

    it("getPatient() should return correct struct for registered patient", async function () {
      const tx = await patientRegistry
        .connect(patient)
        .registerPatient("Alice");
      const ts = await txBlockTimestamp(tx);

      const stored = await patientRegistry.getPatient(patient.address);
      expect(stored.name).to.equal("Alice");
      expect(stored.isRegistered).to.equal(true);
      expect(stored.registeredAt).to.equal(ts);
    });

    it("registerDoctor reverts if licenseHash is zero", async function () {
      await expect(
        patientRegistry
          .connect(owner)
          .registerDoctor(doctor.address, ethers.ZeroHash, HOSPITAL)
      ).to.be.revertedWith("PatientRegistry: licenseHash required");
    });

    it("registerDoctor reverts if hospitalAffiliation is empty", async function () {
      await expect(
        patientRegistry
          .connect(owner)
          .registerDoctor(doctor.address, LICENSE_HASH, "")
      ).to.be.revertedWith("PatientRegistry: hospitalAffiliation required");
    });

    it("registerDoctor reverts if hospitalAffiliation is too long", async function () {
      // 128 is the cap; 129-char string must revert.
      const tooLong = "x".repeat(129);
      await expect(
        patientRegistry
          .connect(owner)
          .registerDoctor(doctor.address, LICENSE_HASH, tooLong)
      ).to.be.revertedWith("PatientRegistry: hospitalAffiliation too long");
    });

    it("registerDoctor reverts on zero address", async function () {
      await expect(
        patientRegistry
          .connect(owner)
          .registerDoctor(ethers.ZeroAddress, LICENSE_HASH, HOSPITAL)
      ).to.be.revertedWith("PatientRegistry: zero address");
    });

    it("registerDoctor reverts if doctor is already an active doctor", async function () {
      await patientRegistry
        .connect(owner)
        .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL);
      await expect(
        patientRegistry
          .connect(owner)
          .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL)
      ).to.be.revertedWith("PatientRegistry: doctor already active");
    });

    it("registerDoctor reverts if address is already a registered patient", async function () {
      await patientRegistry.connect(patient).registerPatient("Alice");
      await expect(
        patientRegistry
          .connect(owner)
          .registerDoctor(patient.address, LICENSE_HASH, HOSPITAL)
      ).to.be.revertedWith(
        "PatientRegistry: address is a registered patient"
      );
    });

    it("revokeDoctor reverts if reason is too long", async function () {
      await patientRegistry
        .connect(owner)
        .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL);
      const tooLong = "x".repeat(201);
      await expect(
        patientRegistry
          .connect(owner)
          .revokeDoctor(doctor.address, tooLong)
      ).to.be.revertedWith("PatientRegistry: reason too long");
    });

    it("revokeDoctor accepts an empty reason string", async function () {
      await patientRegistry
        .connect(owner)
        .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL);

      const tx = await patientRegistry
        .connect(owner)
        .revokeDoctor(doctor.address, "");
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(patientRegistry, "DoctorRevoked")
        .withArgs(doctor.address, "", ts);
    });
  });

  // -----------------------------------------------------------------
  // Doctor encryption public key (ECIES wrap target)
  // -----------------------------------------------------------------
  //
  // These tests need access to the doctor's private key so we can compute
  // the matching uncompressed public key. Hardhat's default signers don't
  // expose their private keys, so we create `ethers.Wallet.createRandom()`
  // wallets and fund them from `owner`.

  describe("setDoctorEncryptionPubKey", function () {
    let doctorWallet;
    let pubKey64; // 64-byte uncompressed pubkey, no 0x04 prefix

    // Helper: strip the leading 0x04 byte from ethers' 65-byte
    // uncompressed public key string.
    function uncompressedPubKeyBytes(wallet) {
      // wallet.signingKey.publicKey === "0x04" + 128 hex chars (= 64 bytes)
      return ethers.dataSlice(wallet.signingKey.publicKey, 1);
    }

    async function makeFundedWallet() {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await owner.sendTransaction({
        to: w.address,
        value: ethers.parseEther("1.0"),
      });
      return w;
    }

    beforeEach(async function () {
      doctorWallet = await makeFundedWallet();
      pubKey64 = uncompressedPubKeyBytes(doctorWallet);
      await patientRegistry
        .connect(owner)
        .registerDoctor(doctorWallet.address, LICENSE_HASH, HOSPITAL);
    });

    it("doctor sets pubkey; emits DoctorPubKeySet; getter returns it", async function () {
      const tx = await patientRegistry
        .connect(doctorWallet)
        .setDoctorEncryptionPubKey(pubKey64);
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(patientRegistry, "DoctorPubKeySet")
        .withArgs(doctorWallet.address, pubKey64, ts);

      const stored = await patientRegistry.getDoctorEncryptionPubKey(
        doctorWallet.address
      );
      expect(stored).to.equal(pubKey64);
    });

    it("getDoctorInfo includes the published pubkey", async function () {
      await patientRegistry
        .connect(doctorWallet)
        .setDoctorEncryptionPubKey(pubKey64);

      const [, , , , encryptionPubKey] = await patientRegistry.getDoctorInfo(
        doctorWallet.address
      );
      expect(encryptionPubKey).to.equal(pubKey64);
    });

    it("reverts if caller is not a registered doctor", async function () {
      const nonDoctor = await makeFundedWallet();
      const nonDoctorPubKey = uncompressedPubKeyBytes(nonDoctor);
      await expect(
        patientRegistry
          .connect(nonDoctor)
          .setDoctorEncryptionPubKey(nonDoctorPubKey)
      ).to.be.revertedWith("PatientRegistry: not a registered doctor");
    });

    it("reverts for a revoked doctor (role check fires first)", async function () {
      // Revoking also clears DOCTOR_ROLE, so the hasRole check is what
      // actually fires here. Test ensures revoked doctors can't set
      // pubkeys regardless of which require trips.
      await patientRegistry
        .connect(owner)
        .revokeDoctor(doctorWallet.address, "test");
      await expect(
        patientRegistry
          .connect(doctorWallet)
          .setDoctorEncryptionPubKey(pubKey64)
      ).to.be.revertedWith("PatientRegistry: not a registered doctor");
    });

    it("reverts on wrong pubkey length", async function () {
      const tooShort = ethers.dataSlice(pubKey64, 0, 63); // 63 bytes
      await expect(
        patientRegistry
          .connect(doctorWallet)
          .setDoctorEncryptionPubKey(tooShort)
      ).to.be.revertedWith(
        "PatientRegistry: pubkey must be 64 bytes uncompressed"
      );

      const tooLong = ethers.concat([pubKey64, "0x00"]); // 65 bytes
      await expect(
        patientRegistry
          .connect(doctorWallet)
          .setDoctorEncryptionPubKey(tooLong)
      ).to.be.revertedWith(
        "PatientRegistry: pubkey must be 64 bytes uncompressed"
      );
    });

    it("accepts a pubkey whose keccak256 does NOT match msg.sender", async function () {
      // The contract deliberately does NOT enforce
      // keccak256(pubKey)[12:] == msg.sender — the doctor's ECIES
      // encryption keypair is HKDF-derived from a MetaMask signature
      // (see frontend/src/utils/crypto.js) and by construction can't
      // satisfy that invariant. This test pins the relaxed behaviour:
      // publishing a pubkey that's intentionally unrelated to the
      // doctor's wallet address must succeed.

      // Use a completely independent wallet's pubkey as the "ECIES key"
      // we're publishing. Its keccak256[12:] derives to otherWallet's
      // address, NOT doctorWallet's — the old contract version would
      // have rejected this; the new one accepts it.
      const otherWallet = await makeFundedWallet();
      const unrelatedPubKey = uncompressedPubKeyBytes(otherWallet);

      // Sanity: confirm the pubkey really would have failed the old
      // address-match check.
      const derivedAddr = ethers.getAddress(
        "0x" +
          ethers
            .keccak256(unrelatedPubKey)
            .slice(2 + 24) // strip "0x" + first 12 bytes (24 hex chars)
      );
      expect(derivedAddr.toLowerCase()).to.equal(
        otherWallet.address.toLowerCase()
      );
      expect(derivedAddr.toLowerCase()).to.not.equal(
        doctorWallet.address.toLowerCase()
      );

      // Publish it — must succeed.
      const tx = await patientRegistry
        .connect(doctorWallet)
        .setDoctorEncryptionPubKey(unrelatedPubKey);
      await tx.wait();

      // On-chain pubkey must be exactly what we sent (not transformed,
      // not derived from msg.sender).
      const stored = await patientRegistry.getDoctorEncryptionPubKey(
        doctorWallet.address
      );
      expect(stored).to.equal(ethers.hexlify(unrelatedPubKey));
    });

    it("reverts on second set from the same doctor", async function () {
      await patientRegistry
        .connect(doctorWallet)
        .setDoctorEncryptionPubKey(pubKey64);

      await expect(
        patientRegistry
          .connect(doctorWallet)
          .setDoctorEncryptionPubKey(pubKey64)
      ).to.be.revertedWith("PatientRegistry: pubkey already set");
    });

    it("getDoctorEncryptionPubKey returns empty bytes before publication", async function () {
      const before = await patientRegistry.getDoctorEncryptionPubKey(
        doctorWallet.address
      );
      expect(before).to.equal("0x");
    });
  });
});
