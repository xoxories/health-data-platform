const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// ---- Constants mirroring contract values ----
const SECONDS_PER_DAY = 24 * 60 * 60;
const EMERGENCY_DURATION = 24 * 60 * 60;
const NO_EXPIRY = 0;
const MAX_EXPIRY_DAYS = 10000;
const MAX_WRAPPED_KEY_LENGTH = 2048;

// Mirrors HealthRecordStorage.RecordCategory ordinals.
const Category = {
  GENERAL: 0,
  BLOOD_TEST: 1,
  IMAGING: 2,
  PRESCRIPTION: 3,
  MENTAL_HEALTH: 4,
  GENETIC: 5,
  OTHER: 6,
};

const LICENSE_HASH = ethers.keccak256(ethers.toUtf8Bytes("MD-12345"));
const HOSPITAL = "General Hospital";

function wrappedKey(label) {
  return ethers.toUtf8Bytes(label);
}

async function txBlockTimestamp(tx) {
  const receipt = await tx.wait();
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  return block.timestamp;
}

describe("ConsentManager", function () {
  let patientRegistry;
  let consentManager;
  let owner; // accounts[0]
  let patient; // accounts[1]
  let doctor; // accounts[2]
  let other; // accounts[3] — unregistered

  beforeEach(async function () {
    [owner, patient, doctor, other] = await ethers.getSigners();

    const PatientRegistry = await ethers.getContractFactory("PatientRegistry");
    patientRegistry = await PatientRegistry.deploy();
    await patientRegistry.waitForDeployment();

    const ConsentManager = await ethers.getContractFactory("ConsentManager");
    consentManager = await ConsentManager.deploy(
      await patientRegistry.getAddress()
    );
    await consentManager.waitForDeployment();

    await patientRegistry.connect(patient).registerPatient("Alice");
    await patientRegistry
      .connect(owner)
      .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL);
  });

  // -----------------------------------------------------------------
  // requestAccess
  // -----------------------------------------------------------------

  describe("requestAccess", function () {
    it("doctor can request access; emits AccessRequested", async function () {
      const tx = await consentManager
        .connect(doctor)
        .requestAccess(patient.address);
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(consentManager, "AccessRequested")
        .withArgs(patient.address, doctor.address, ts);
    });

    it("getPendingRequests returns the requesting doctor", async function () {
      await consentManager.connect(doctor).requestAccess(patient.address);
      const pending = await consentManager.getPendingRequests(patient.address);
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(doctor.address);
    });

    it("non-doctor cannot requestAccess", async function () {
      await expect(
        consentManager.connect(other).requestAccess(patient.address)
      ).to.be.revertedWith(
        "ConsentManager: caller is not a registered doctor"
      );
    });

    it("requestAccess reverts if target is not a registered patient", async function () {
      await expect(
        consentManager.connect(doctor).requestAccess(other.address)
      ).to.be.revertedWith(
        "ConsentManager: target is not a registered patient"
      );
    });

    it("duplicate pending request reverts", async function () {
      await consentManager.connect(doctor).requestAccess(patient.address);
      await expect(
        consentManager.connect(doctor).requestAccess(patient.address)
      ).to.be.revertedWith(
        "ConsentManager: access request already pending"
      );
    });
  });

  // -----------------------------------------------------------------
  // grantAccess — new categorised signature
  // -----------------------------------------------------------------

  describe("grantAccess", function () {
    it("grants single category permanently; emits AccessGranted with correct bitmap", async function () {
      const tx = await consentManager
        .connect(patient)
        .grantAccess(
          doctor.address,
          [Category.BLOOD_TEST],
          0,
          [wrappedKey("k-blood")]
        );
      const ts = await txBlockTimestamp(tx);
      const expectedBitmap = 1 << Category.BLOOD_TEST;

      await expect(tx)
        .to.emit(consentManager, "AccessGranted")
        .withArgs(
          patient.address,
          doctor.address,
          expectedBitmap,
          NO_EXPIRY,
          ts
        );
    });

    it("grants multiple categories; bitmap is the union", async function () {
      const cats = [Category.BLOOD_TEST, Category.IMAGING, Category.GENETIC];
      const keys = [
        wrappedKey("k-blood"),
        wrappedKey("k-img"),
        wrappedKey("k-gen"),
      ];

      const tx = await consentManager
        .connect(patient)
        .grantAccess(doctor.address, cats, 0, keys);
      const ts = await txBlockTimestamp(tx);

      const expectedBitmap =
        (1 << Category.BLOOD_TEST) |
        (1 << Category.IMAGING) |
        (1 << Category.GENETIC);

      await expect(tx)
        .to.emit(consentManager, "AccessGranted")
        .withArgs(
          patient.address,
          doctor.address,
          expectedBitmap,
          NO_EXPIRY,
          ts
        );

      const consent = await consentManager.getConsent(
        patient.address,
        doctor.address
      );
      expect(consent.isActive).to.equal(true);
      expect(consent.categoryBitmap).to.equal(expectedBitmap);
      expect(consent.expiresAt).to.equal(NO_EXPIRY);
    });

    it("grants with expiry; expiresAt = grantedAt + days * 86400", async function () {
      const expiryDays = 30;
      const tx = await consentManager
        .connect(patient)
        .grantAccess(
          doctor.address,
          [Category.BLOOD_TEST],
          expiryDays,
          [wrappedKey("k")]
        );
      const ts = await txBlockTimestamp(tx);
      const expectedExpiresAt = ts + expiryDays * SECONDS_PER_DAY;

      await expect(tx)
        .to.emit(consentManager, "AccessGranted")
        .withArgs(
          patient.address,
          doctor.address,
          1 << Category.BLOOD_TEST,
          expectedExpiresAt,
          ts
        );

      const consent = await consentManager.getConsent(
        patient.address,
        doctor.address
      );
      expect(consent.expiresAt).to.equal(expectedExpiresAt);
    });

    it("clears pending request after grant", async function () {
      await consentManager.connect(doctor).requestAccess(patient.address);
      expect(
        (await consentManager.getPendingRequests(patient.address)).length
      ).to.equal(1);

      await consentManager
        .connect(patient)
        .grantAccess(
          doctor.address,
          [Category.BLOOD_TEST],
          0,
          [wrappedKey("k")]
        );
      expect(
        (await consentManager.getPendingRequests(patient.address)).length
      ).to.equal(0);
    });

    it("non-patient cannot grantAccess", async function () {
      await expect(
        consentManager
          .connect(other)
          .grantAccess(
            doctor.address,
            [Category.BLOOD_TEST],
            0,
            [wrappedKey("k")]
          )
      ).to.be.revertedWith(
        "ConsentManager: caller is not a registered patient"
      );
    });

    it("cannot grant access to non-doctor target", async function () {
      await expect(
        consentManager
          .connect(patient)
          .grantAccess(
            other.address,
            [Category.BLOOD_TEST],
            0,
            [wrappedKey("k")]
          )
      ).to.be.revertedWith(
        "ConsentManager: target is not a registered doctor"
      );
    });

    it("reverts with empty categories array", async function () {
      await expect(
        consentManager
          .connect(patient)
          .grantAccess(doctor.address, [], 0, [])
      ).to.be.revertedWith(
        "ConsentManager: at least one category required"
      );
    });

    it("reverts on categories/keys length mismatch", async function () {
      await expect(
        consentManager
          .connect(patient)
          .grantAccess(
            doctor.address,
            [Category.BLOOD_TEST, Category.IMAGING],
            0,
            [wrappedKey("only-one")]
          )
      ).to.be.revertedWith(
        "ConsentManager: categories/keys length mismatch"
      );
    });

    it("reverts on invalid category index", async function () {
      await expect(
        consentManager
          .connect(patient)
          .grantAccess(doctor.address, [99], 0, [wrappedKey("k")])
      ).to.be.revertedWith("ConsentManager: invalid category");
    });

    it("reverts on empty wrapped key", async function () {
      await expect(
        consentManager
          .connect(patient)
          .grantAccess(
            doctor.address,
            [Category.BLOOD_TEST],
            0,
            [new Uint8Array(0)]
          )
      ).to.be.revertedWith("ConsentManager: wrapped key required");
    });

    it("reverts on too-long wrapped key", async function () {
      const tooLong = new Uint8Array(MAX_WRAPPED_KEY_LENGTH + 1);
      await expect(
        consentManager
          .connect(patient)
          .grantAccess(
            doctor.address,
            [Category.BLOOD_TEST],
            0,
            [tooLong]
          )
      ).to.be.revertedWith("ConsentManager: wrapped key too long");
    });

    it("reverts on excessive expiryDays", async function () {
      await expect(
        consentManager
          .connect(patient)
          .grantAccess(
            doctor.address,
            [Category.BLOOD_TEST],
            MAX_EXPIRY_DAYS + 1,
            [wrappedKey("k")]
          )
      ).to.be.revertedWith("ConsentManager: expiryDays exceeds maximum");
    });
  });

  // -----------------------------------------------------------------
  // hasAccessForCategory
  // -----------------------------------------------------------------

  describe("hasAccessForCategory", function () {
    beforeEach(async function () {
      await consentManager
        .connect(patient)
        .grantAccess(
          doctor.address,
          [Category.BLOOD_TEST, Category.IMAGING],
          0,
          [wrappedKey("k-blood"), wrappedKey("k-img")]
        );
    });

    it("returns true for covered categories", async function () {
      expect(
        await consentManager.hasAccessForCategory(
          patient.address,
          doctor.address,
          Category.BLOOD_TEST
        )
      ).to.equal(true);
      expect(
        await consentManager.hasAccessForCategory(
          patient.address,
          doctor.address,
          Category.IMAGING
        )
      ).to.equal(true);
    });

    it("returns false for uncovered categories", async function () {
      expect(
        await consentManager.hasAccessForCategory(
          patient.address,
          doctor.address,
          Category.GENERAL
        )
      ).to.equal(false);
      expect(
        await consentManager.hasAccessForCategory(
          patient.address,
          doctor.address,
          Category.MENTAL_HEALTH
        )
      ).to.equal(false);
    });

    it("returns false after revoke", async function () {
      await consentManager.connect(patient).revokeAccess(doctor.address);
      expect(
        await consentManager.hasAccessForCategory(
          patient.address,
          doctor.address,
          Category.BLOOD_TEST
        )
      ).to.equal(false);
    });

    it("reverts on invalid category index", async function () {
      await expect(
        consentManager.hasAccessForCategory(
          patient.address,
          doctor.address,
          99
        )
      ).to.be.revertedWith("ConsentManager: invalid category");
    });
  });

  // -----------------------------------------------------------------
  // getDoctorWrappedKey
  // -----------------------------------------------------------------

  describe("getDoctorWrappedKey", function () {
    beforeEach(async function () {
      await consentManager
        .connect(patient)
        .grantAccess(
          doctor.address,
          [Category.BLOOD_TEST, Category.IMAGING],
          0,
          [wrappedKey("k-blood"), wrappedKey("k-img")]
        );
    });

    it("returns the stored blob for a granted category", async function () {
      const blood = await consentManager.getDoctorWrappedKey(
        patient.address,
        doctor.address,
        Category.BLOOD_TEST
      );
      expect(ethers.toUtf8String(blood)).to.equal("k-blood");

      const img = await consentManager.getDoctorWrappedKey(
        patient.address,
        doctor.address,
        Category.IMAGING
      );
      expect(ethers.toUtf8String(img)).to.equal("k-img");
    });

    it("returns empty bytes for category never granted", async function () {
      const empty = await consentManager.getDoctorWrappedKey(
        patient.address,
        doctor.address,
        Category.GENETIC
      );
      expect(empty).to.equal("0x");
    });
  });

  // -----------------------------------------------------------------
  // revokeAccess
  // -----------------------------------------------------------------

  describe("revokeAccess", function () {
    beforeEach(async function () {
      await consentManager
        .connect(patient)
        .grantAccess(
          doctor.address,
          [Category.BLOOD_TEST],
          0,
          [wrappedKey("k")]
        );
    });

    it("emits AccessRevoked", async function () {
      const tx = await consentManager
        .connect(patient)
        .revokeAccess(doctor.address);
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(consentManager, "AccessRevoked")
        .withArgs(patient.address, doctor.address, ts);
    });

    it("hasAccess returns false after revoke", async function () {
      expect(
        await consentManager.hasAccess(patient.address, doctor.address)
      ).to.equal(true);
      await consentManager.connect(patient).revokeAccess(doctor.address);
      expect(
        await consentManager.hasAccess(patient.address, doctor.address)
      ).to.equal(false);
    });

    it("reverts on already-inactive consent (idempotency guard)", async function () {
      await consentManager.connect(patient).revokeAccess(doctor.address);
      await expect(
        consentManager.connect(patient).revokeAccess(doctor.address)
      ).to.be.revertedWith(
        "ConsentManager: no active consent to revoke"
      );
    });
  });

  // -----------------------------------------------------------------
  // Expiry
  // -----------------------------------------------------------------

  describe("Expiry", function () {
    it("hasAccessForCategory returns false after expiry passes", async function () {
      const expiryDays = 30;
      await consentManager
        .connect(patient)
        .grantAccess(
          doctor.address,
          [Category.BLOOD_TEST],
          expiryDays,
          [wrappedKey("k")]
        );
      await time.increase(expiryDays * SECONDS_PER_DAY);
      expect(
        await consentManager.hasAccessForCategory(
          patient.address,
          doctor.address,
          Category.BLOOD_TEST
        )
      ).to.equal(false);
    });

    it("hasAccessForCategory returns true one second before expiry", async function () {
      const expiryDays = 30;
      await consentManager
        .connect(patient)
        .grantAccess(
          doctor.address,
          [Category.BLOOD_TEST],
          expiryDays,
          [wrappedKey("k")]
        );
      await time.increase(expiryDays * SECONDS_PER_DAY - 1);
      expect(
        await consentManager.hasAccessForCategory(
          patient.address,
          doctor.address,
          Category.BLOOD_TEST
        )
      ).to.equal(true);
    });
  });

  // -----------------------------------------------------------------
  // emergencyAccess
  // -----------------------------------------------------------------

  describe("emergencyAccess", function () {
    it("doctor invokes; emits EmergencyAccessInvoked; 24h window set", async function () {
      const reason = "Patient unconscious in ER";
      const tx = await consentManager
        .connect(doctor)
        .emergencyAccess(patient.address, reason);
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(consentManager, "EmergencyAccessInvoked")
        .withArgs(doctor.address, patient.address, reason, ts);

      expect(
        await consentManager.hasEmergencyAccess(
          patient.address,
          doctor.address
        )
      ).to.equal(true);

      const expiry = await consentManager.getEmergencyAccessExpiry(
        patient.address,
        doctor.address
      );
      expect(expiry).to.equal(ts + EMERGENCY_DURATION);
    });

    it("hasEmergencyAccess returns false after the 24h window", async function () {
      await consentManager
        .connect(doctor)
        .emergencyAccess(patient.address, "ER");
      await time.increase(EMERGENCY_DURATION);
      expect(
        await consentManager.hasEmergencyAccess(
          patient.address,
          doctor.address
        )
      ).to.equal(false);
    });

    it("hasEmergencyAccess returns true 1s before expiry", async function () {
      await consentManager
        .connect(doctor)
        .emergencyAccess(patient.address, "ER");
      await time.increase(EMERGENCY_DURATION - 1);
      expect(
        await consentManager.hasEmergencyAccess(
          patient.address,
          doctor.address
        )
      ).to.equal(true);
    });

    it("non-doctor cannot invoke emergency access", async function () {
      await expect(
        consentManager
          .connect(other)
          .emergencyAccess(patient.address, "reason")
      ).to.be.revertedWith(
        "ConsentManager: caller is not a registered doctor"
      );
    });

    it("reverts if target is not a registered patient", async function () {
      await expect(
        consentManager
          .connect(doctor)
          .emergencyAccess(other.address, "reason")
      ).to.be.revertedWith(
        "ConsentManager: target is not a registered patient"
      );
    });

    it("reverts on empty reason", async function () {
      await expect(
        consentManager.connect(doctor).emergencyAccess(patient.address, "")
      ).to.be.revertedWith("ConsentManager: reason required");
    });

    it("reverts on too-long reason", async function () {
      const tooLong = "x".repeat(201);
      await expect(
        consentManager
          .connect(doctor)
          .emergencyAccess(patient.address, tooLong)
      ).to.be.revertedWith("ConsentManager: reason too long");
    });
  });

  // -----------------------------------------------------------------
  // clearEmergencyAccess
  // -----------------------------------------------------------------

  describe("clearEmergencyAccess", function () {
    beforeEach(async function () {
      await consentManager
        .connect(doctor)
        .emergencyAccess(patient.address, "ER triage");
    });

    it("patient clears emergency access; emits EmergencyAccessCleared", async function () {
      const tx = await consentManager
        .connect(patient)
        .clearEmergencyAccess(doctor.address);
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(consentManager, "EmergencyAccessCleared")
        .withArgs(patient.address, doctor.address, ts);

      expect(
        await consentManager.hasEmergencyAccess(
          patient.address,
          doctor.address
        )
      ).to.equal(false);
    });

    it("reverts if there is no active emergency access", async function () {
      await consentManager
        .connect(patient)
        .clearEmergencyAccess(doctor.address);
      await expect(
        consentManager
          .connect(patient)
          .clearEmergencyAccess(doctor.address)
      ).to.be.revertedWith(
        "ConsentManager: no active emergency access"
      );
    });
  });
});
