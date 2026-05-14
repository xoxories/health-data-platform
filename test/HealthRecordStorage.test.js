const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// ---- Constants ----
const EMERGENCY_DURATION = 24 * 60 * 60;
const MAX_CID_LENGTH = 100;
const MAX_ENCRYPTED_KEY_LENGTH = 2048;

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

const VALID_CID_1 = "QmTzQ1Nj5UpTbgqyUCgPpNkXq7CrLwY9Z5XKkPkV4hHX5j";
const VALID_CID_2 = "QmSdGqPaB6CbqqJVYTgkqz8YGzkwHFPVPqK7sFvz4kT5wY";
const VALID_CID_3 = "QmRfP2vN5Ts8MtQzCvB9KzWqLaP3HdN4uYvXgK7sJpRzAB";

function wrappedKey(label) {
  return ethers.toUtf8Bytes(label);
}

async function txBlockTimestamp(tx) {
  const receipt = await tx.wait();
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  return block.timestamp;
}

describe("HealthRecordStorage", function () {
  let patientRegistry;
  let consentManager;
  let healthRecordStorage;
  let owner; // accounts[0]
  let patient; // accounts[1]
  let doctor; // accounts[2] — registered doctor
  let other; // accounts[3] — unregistered
  let otherPatient; // accounts[4] — second patient
  let otherDoctor; // accounts[5] — second doctor, registered but no consent

  beforeEach(async function () {
    [owner, patient, doctor, other, otherPatient, otherDoctor] =
      await ethers.getSigners();

    const PatientRegistry = await ethers.getContractFactory("PatientRegistry");
    patientRegistry = await PatientRegistry.deploy();
    await patientRegistry.waitForDeployment();

    const ConsentManager = await ethers.getContractFactory("ConsentManager");
    consentManager = await ConsentManager.deploy(
      await patientRegistry.getAddress()
    );
    await consentManager.waitForDeployment();

    const HealthRecordStorage = await ethers.getContractFactory(
      "HealthRecordStorage"
    );
    healthRecordStorage = await HealthRecordStorage.deploy(
      await patientRegistry.getAddress(),
      await consentManager.getAddress()
    );
    await healthRecordStorage.waitForDeployment();

    await patientRegistry.connect(patient).registerPatient("Alice");
    await patientRegistry
      .connect(owner)
      .registerDoctor(doctor.address, LICENSE_HASH, HOSPITAL);
  });

  // -----------------------------------------------------------------
  // storeRecord
  // -----------------------------------------------------------------

  describe("storeRecord", function () {
    it("patient stores a record; emits RecordStored; first recordId is 1", async function () {
      const tx = await healthRecordStorage
        .connect(patient)
        .storeRecord(VALID_CID_1, Category.BLOOD_TEST, wrappedKey("k1"));
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(healthRecordStorage, "RecordStored")
        .withArgs(patient.address, 1, Category.BLOOD_TEST, VALID_CID_1, ts);
    });

    it("global recordCounter increments across patients", async function () {
      await patientRegistry.connect(otherPatient).registerPatient("Bob");

      await healthRecordStorage
        .connect(patient)
        .storeRecord(VALID_CID_1, Category.BLOOD_TEST, wrappedKey("k1"));
      await healthRecordStorage
        .connect(otherPatient)
        .storeRecord(VALID_CID_2, Category.IMAGING, wrappedKey("k2"));

      expect(await healthRecordStorage.totalRecordCount()).to.equal(2);

      const aliceIds = await healthRecordStorage
        .connect(patient)
        .getRecordIdsForPatient(patient.address);
      const bobIds = await healthRecordStorage
        .connect(otherPatient)
        .getRecordIdsForPatient(otherPatient.address);

      expect(aliceIds.map((x) => Number(x))).to.deep.equal([1]);
      expect(bobIds.map((x) => Number(x))).to.deep.equal([2]);
    });

    it("stored fields round-trip via getRecord", async function () {
      const tx = await healthRecordStorage
        .connect(patient)
        .storeRecord(VALID_CID_1, Category.IMAGING, wrappedKey("k1"));
      const ts = await txBlockTimestamp(tx);

      const rec = await healthRecordStorage.connect(patient).getRecord(1);
      expect(rec.patient).to.equal(patient.address);
      expect(rec.ipfsCID).to.equal(VALID_CID_1);
      expect(rec.category).to.equal(Category.IMAGING);
      expect(rec.isActive).to.equal(true);
      expect(rec.uploadedBy).to.equal(patient.address);
      expect(rec.createdAt).to.equal(ts);
      expect(ethers.toUtf8String(rec.encryptedKey)).to.equal("k1");
    });

    it("reverts if caller is not a registered patient", async function () {
      await expect(
        healthRecordStorage
          .connect(other)
          .storeRecord(VALID_CID_1, Category.BLOOD_TEST, wrappedKey("k"))
      ).to.be.revertedWith(
        "HealthRecordStorage: caller is not a registered patient"
      );
    });

    it("reverts on empty CID", async function () {
      await expect(
        healthRecordStorage
          .connect(patient)
          .storeRecord("", Category.BLOOD_TEST, wrappedKey("k"))
      ).to.be.revertedWith("HealthRecordStorage: ipfsCID required");
    });

    it("reverts on too-long CID", async function () {
      const tooLong = "Q".repeat(MAX_CID_LENGTH + 1);
      await expect(
        healthRecordStorage
          .connect(patient)
          .storeRecord(tooLong, Category.BLOOD_TEST, wrappedKey("k"))
      ).to.be.revertedWith("HealthRecordStorage: ipfsCID too long");
    });

    it("reverts on empty encryptedKey", async function () {
      await expect(
        healthRecordStorage
          .connect(patient)
          .storeRecord(VALID_CID_1, Category.BLOOD_TEST, new Uint8Array(0))
      ).to.be.revertedWith("HealthRecordStorage: encryptedKey required");
    });

    it("reverts on too-long encryptedKey", async function () {
      const tooLong = new Uint8Array(MAX_ENCRYPTED_KEY_LENGTH + 1);
      await expect(
        healthRecordStorage
          .connect(patient)
          .storeRecord(VALID_CID_1, Category.BLOOD_TEST, tooLong)
      ).to.be.revertedWith("HealthRecordStorage: encryptedKey too long");
    });
  });

  // -----------------------------------------------------------------
  // getRecord / getRecords / getActiveRecords / getRecordIdsForPatient
  // -----------------------------------------------------------------

  describe("read views", function () {
    beforeEach(async function () {
      await healthRecordStorage
        .connect(patient)
        .storeRecord(VALID_CID_1, Category.BLOOD_TEST, wrappedKey("k1"));
      await healthRecordStorage
        .connect(patient)
        .storeRecord(VALID_CID_2, Category.IMAGING, wrappedKey("k2"));
      await healthRecordStorage
        .connect(patient)
        .storeRecord(VALID_CID_3, Category.GENETIC, wrappedKey("k3"));
    });

    it("patient can read their own record via getRecord", async function () {
      const rec = await healthRecordStorage.connect(patient).getRecord(1);
      expect(rec.ipfsCID).to.equal(VALID_CID_1);
    });

    it("getRecords returns all records (active + deleted) in insertion order", async function () {
      const records = await healthRecordStorage
        .connect(patient)
        .getRecords(patient.address);
      expect(records.length).to.equal(3);
      expect(records.map((r) => r.ipfsCID)).to.deep.equal([
        VALID_CID_1,
        VALID_CID_2,
        VALID_CID_3,
      ]);
    });

    it("getActiveRecords filters out soft-deleted records", async function () {
      await healthRecordStorage.connect(patient).deleteRecord(2);
      const active = await healthRecordStorage
        .connect(patient)
        .getActiveRecords(patient.address);
      expect(active.length).to.equal(2);
      expect(active.map((r) => r.ipfsCID)).to.deep.equal([
        VALID_CID_1,
        VALID_CID_3,
      ]);
    });

    it("getRecordIdsForPatient returns IDs in insertion order", async function () {
      const ids = await healthRecordStorage
        .connect(patient)
        .getRecordIdsForPatient(patient.address);
      expect(ids.map((x) => Number(x))).to.deep.equal([1, 2, 3]);
    });

    it("getRecord reverts on non-existent id", async function () {
      await expect(
        healthRecordStorage.connect(patient).getRecord(999)
      ).to.be.revertedWith("HealthRecordStorage: record not found");
    });

    it("doctor with catch-all consent can call getRecord (legacy path)", async function () {
      // Any category granted -> hasAccess returns true -> getRecord allowed.
      await consentManager
        .connect(patient)
        .grantAccess(
          doctor.address,
          [Category.BLOOD_TEST],
          0,
          [wrappedKey("k-blood")]
        );
      const rec = await healthRecordStorage.connect(doctor).getRecord(1);
      expect(rec.ipfsCID).to.equal(VALID_CID_1);
    });

    it("doctor without consent cannot call getRecord", async function () {
      await expect(
        healthRecordStorage.connect(doctor).getRecord(1)
      ).to.be.revertedWith("No access permission");
    });

    it("unrelated address cannot call getRecord", async function () {
      await expect(
        healthRecordStorage.connect(other).getRecord(1)
      ).to.be.revertedWith("No access permission");
    });

    it("getRecords reverts for unauthorised caller", async function () {
      await expect(
        healthRecordStorage.connect(other).getRecords(patient.address)
      ).to.be.revertedWith("No access permission");
    });

    it("getActiveRecords reverts for unauthorised caller", async function () {
      await expect(
        healthRecordStorage.connect(other).getActiveRecords(patient.address)
      ).to.be.revertedWith("No access permission");
    });
  });

  // -----------------------------------------------------------------
  // deleteRecord
  // -----------------------------------------------------------------

  describe("deleteRecord", function () {
    beforeEach(async function () {
      await healthRecordStorage
        .connect(patient)
        .storeRecord(VALID_CID_1, Category.BLOOD_TEST, wrappedKey("k1"));
    });

    it("patient can delete; emits RecordDeleted; isActive becomes false", async function () {
      const tx = await healthRecordStorage.connect(patient).deleteRecord(1);
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(healthRecordStorage, "RecordDeleted")
        .withArgs(patient.address, 1, ts);

      const rec = await healthRecordStorage.connect(patient).getRecord(1);
      expect(rec.isActive).to.equal(false);
    });

    it("non-owner cannot delete (msg.sender != record.patient)", async function () {
      await expect(
        healthRecordStorage.connect(doctor).deleteRecord(1)
      ).to.be.revertedWith("HealthRecordStorage: not your record");
    });

    it("reverts on non-existent record (treated as 'not your record')", async function () {
      await expect(
        healthRecordStorage.connect(patient).deleteRecord(999)
      ).to.be.revertedWith("HealthRecordStorage: not your record");
    });

    it("reverts on already-deleted record (idempotency)", async function () {
      await healthRecordStorage.connect(patient).deleteRecord(1);
      await expect(
        healthRecordStorage.connect(patient).deleteRecord(1)
      ).to.be.revertedWith(
        "HealthRecordStorage: record already deleted"
      );
    });

    it("audit history survives delete: record still indexed and readable", async function () {
      await healthRecordStorage.connect(patient).deleteRecord(1);

      // ID list unchanged.
      const ids = await healthRecordStorage
        .connect(patient)
        .getRecordIdsForPatient(patient.address);
      expect(ids.map((x) => Number(x))).to.deep.equal([1]);

      // Full record still in storage.
      const rec = await healthRecordStorage.connect(patient).getRecord(1);
      expect(rec.patient).to.equal(patient.address);
      expect(rec.ipfsCID).to.equal(VALID_CID_1);
      expect(rec.isActive).to.equal(false);
    });
  });

  // -----------------------------------------------------------------
  // getRecordForDoctor — regular consent path
  // -----------------------------------------------------------------

  describe("getRecordForDoctor (regular consent)", function () {
    beforeEach(async function () {
      // Two records in two different categories.
      await healthRecordStorage
        .connect(patient)
        .storeRecord(
          VALID_CID_1,
          Category.BLOOD_TEST,
          wrappedKey("patient-wrapped-blood")
        );
      await healthRecordStorage
        .connect(patient)
        .storeRecord(
          VALID_CID_2,
          Category.IMAGING,
          wrappedKey("patient-wrapped-imaging")
        );

      // Doctor has consent only for BLOOD_TEST.
      await consentManager
        .connect(patient)
        .grantAccess(
          doctor.address,
          [Category.BLOOD_TEST],
          0,
          [wrappedKey("doctor-wrapped-blood")]
        );
    });

    it("returns cid + doctor-wrapped key; emits RecordAccessed", async function () {
      // staticCall to inspect return values without changing state.
      const result = await healthRecordStorage
        .connect(doctor)
        .getRecordForDoctor.staticCall(1, doctor.address);
      expect(result[0]).to.equal(VALID_CID_1);
      expect(ethers.toUtf8String(result[1])).to.equal(
        "doctor-wrapped-blood"
      );

      // Real call to assert the audit event.
      const tx = await healthRecordStorage
        .connect(doctor)
        .getRecordForDoctor(1, doctor.address);
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(healthRecordStorage, "RecordAccessed")
        .withArgs(patient.address, doctor.address, 1, ts);
      await expect(tx).to.not.emit(
        healthRecordStorage,
        "EmergencyRecordAccessed"
      );
    });

    it("reverts if record category is outside the doctor's consent", async function () {
      // Record #2 is IMAGING; doctor only consented to BLOOD_TEST.
      await expect(
        healthRecordStorage
          .connect(doctor)
          .getRecordForDoctor(2, doctor.address)
      ).to.be.revertedWith(
        "HealthRecordStorage: no consent and no emergency access"
      );
    });

    it("reverts if doctor parameter != msg.sender (audit-log integrity)", async function () {
      await expect(
        healthRecordStorage
          .connect(other)
          .getRecordForDoctor(1, doctor.address)
      ).to.be.revertedWith(
        "HealthRecordStorage: doctor must equal caller"
      );
    });

    it("reverts on non-existent recordId", async function () {
      await expect(
        healthRecordStorage
          .connect(doctor)
          .getRecordForDoctor(999, doctor.address)
      ).to.be.revertedWith("HealthRecordStorage: record not found");
    });

    it("reverts on deleted record", async function () {
      await healthRecordStorage.connect(patient).deleteRecord(1);
      await expect(
        healthRecordStorage
          .connect(doctor)
          .getRecordForDoctor(1, doctor.address)
      ).to.be.revertedWith("HealthRecordStorage: record deleted");
    });

    it("reverts after consent is revoked", async function () {
      await consentManager.connect(patient).revokeAccess(doctor.address);
      await expect(
        healthRecordStorage
          .connect(doctor)
          .getRecordForDoctor(1, doctor.address)
      ).to.be.revertedWith(
        "HealthRecordStorage: no consent and no emergency access"
      );
    });

    it("a different registered doctor with no consent cannot access", async function () {
      await patientRegistry
        .connect(owner)
        .registerDoctor(
          otherDoctor.address,
          ethers.keccak256(ethers.toUtf8Bytes("MD-OTHER")),
          "Different Hospital"
        );
      await expect(
        healthRecordStorage
          .connect(otherDoctor)
          .getRecordForDoctor(1, otherDoctor.address)
      ).to.be.revertedWith(
        "HealthRecordStorage: no consent and no emergency access"
      );
    });
  });

  // -----------------------------------------------------------------
  // getRecordForDoctor — emergency access path
  // -----------------------------------------------------------------

  describe("getRecordForDoctor (emergency access)", function () {
    beforeEach(async function () {
      // One MENTAL_HEALTH record, deliberately outside any normal consent.
      await healthRecordStorage
        .connect(patient)
        .storeRecord(
          VALID_CID_1,
          Category.MENTAL_HEALTH,
          wrappedKey("patient-wrapped-mh")
        );
    });

    it("doctor with only emergency access: returns patient-wrapped key; emits EmergencyRecordAccessed (NOT RecordAccessed)", async function () {
      await consentManager
        .connect(doctor)
        .emergencyAccess(patient.address, "Patient unconscious in ER");

      const result = await healthRecordStorage
        .connect(doctor)
        .getRecordForDoctor.staticCall(1, doctor.address);
      expect(result[0]).to.equal(VALID_CID_1);
      // Under emergency, return value is record.encryptedKey (patient-wrapped).
      expect(ethers.toUtf8String(result[1])).to.equal(
        "patient-wrapped-mh"
      );

      const tx = await healthRecordStorage
        .connect(doctor)
        .getRecordForDoctor(1, doctor.address);
      const ts = await txBlockTimestamp(tx);

      await expect(tx)
        .to.emit(healthRecordStorage, "EmergencyRecordAccessed")
        .withArgs(patient.address, doctor.address, 1, ts);
      // Crucial property: emergency flows MUST NOT emit RecordAccessed.
      await expect(tx).to.not.emit(healthRecordStorage, "RecordAccessed");
    });

    it("regular consent takes precedence over emergency when both are active", async function () {
      // Grant regular consent for MENTAL_HEALTH with its own doctor-wrapped key.
      await consentManager
        .connect(patient)
        .grantAccess(
          doctor.address,
          [Category.MENTAL_HEALTH],
          0,
          [wrappedKey("doctor-wrapped-mh")]
        );
      // Doctor also invokes emergency access on top of regular consent.
      await consentManager
        .connect(doctor)
        .emergencyAccess(patient.address, "Also emergency");

      const result = await healthRecordStorage
        .connect(doctor)
        .getRecordForDoctor.staticCall(1, doctor.address);
      // Returned key is the doctor-wrapped one, NOT the patient-wrapped one.
      expect(ethers.toUtf8String(result[1])).to.equal(
        "doctor-wrapped-mh"
      );

      const tx = await healthRecordStorage
        .connect(doctor)
        .getRecordForDoctor(1, doctor.address);

      await expect(tx).to.emit(healthRecordStorage, "RecordAccessed");
      await expect(tx).to.not.emit(
        healthRecordStorage,
        "EmergencyRecordAccessed"
      );
    });

    it("after the 24h emergency window expires, getRecordForDoctor reverts", async function () {
      await consentManager
        .connect(doctor)
        .emergencyAccess(patient.address, "ER");
      await time.increase(EMERGENCY_DURATION);
      await expect(
        healthRecordStorage
          .connect(doctor)
          .getRecordForDoctor(1, doctor.address)
      ).to.be.revertedWith(
        "HealthRecordStorage: no consent and no emergency access"
      );
    });

    it("a patient-cleared emergency window blocks further reads", async function () {
      await consentManager
        .connect(doctor)
        .emergencyAccess(patient.address, "ER");
      await consentManager
        .connect(patient)
        .clearEmergencyAccess(doctor.address);
      await expect(
        healthRecordStorage
          .connect(doctor)
          .getRecordForDoctor(1, doctor.address)
      ).to.be.revertedWith(
        "HealthRecordStorage: no consent and no emergency access"
      );
    });
  });

  // -----------------------------------------------------------------
  // totalRecordCount
  // -----------------------------------------------------------------

  describe("totalRecordCount", function () {
    it("starts at zero", async function () {
      expect(await healthRecordStorage.totalRecordCount()).to.equal(0);
    });

    it("increments by one per storeRecord", async function () {
      await healthRecordStorage
        .connect(patient)
        .storeRecord(VALID_CID_1, Category.BLOOD_TEST, wrappedKey("k1"));
      expect(await healthRecordStorage.totalRecordCount()).to.equal(1);
      await healthRecordStorage
        .connect(patient)
        .storeRecord(VALID_CID_2, Category.IMAGING, wrappedKey("k2"));
      expect(await healthRecordStorage.totalRecordCount()).to.equal(2);
    });
  });
});
