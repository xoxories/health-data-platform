// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// =====================================================================
// External interfaces
// =====================================================================

/**
 * @dev Minimal surface of the PatientRegistry contract that this contract
 *      relies on. Declared locally so HealthRecordStorage stays decoupled
 *      from the full PatientRegistry implementation.
 */
interface IPatientRegistry {
    function isPatient(address account) external view returns (bool);
}

/**
 * @dev Minimal surface of the ConsentManager contract. `hasAccess` is the
 *      legacy catch-all consent check used by the patient-facing reads
 *      below. `hasAccessForCategory` and `getDoctorWrappedKey` power the
 *      new category-scoped, envelope-encrypted access path.
 */
interface IConsentManager {
    function hasAccess(address patient, address requester)
        external
        view
        returns (bool);

    function hasAccessForCategory(
        address patient,
        address doctor,
        uint8 category
    ) external view returns (bool);

    function hasEmergencyAccess(address patient, address doctor)
        external
        view
        returns (bool);

    function getDoctorWrappedKey(
        address patient,
        address doctor,
        uint8 category
    ) external view returns (bytes memory);
}

// =====================================================================
// HealthRecordStorage
// =====================================================================

/**
 * @title  HealthRecordStorage
 * @notice On-chain index of off-chain (IPFS) encrypted health records.
 *         Records are stored with a global, monotonically-increasing ID
 *         to enable per-record category-scoped consent and a per-record
 *         on-chain audit log of doctor accesses.
 */
contract HealthRecordStorage is Ownable {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice Canonical category taxonomy for a stored health record.
    ///         Maps 1-to-1 with `uint8` for cross-contract calls into
    ///         {ConsentManager}.
    enum RecordCategory {
        GENERAL,
        BLOOD_TEST,
        IMAGING,
        PRESCRIPTION,
        MENTAL_HEALTH,
        GENETIC,
        OTHER
    }

    /**
     * @dev Field declaration order is chosen for storage packing:
     *
     *      Slot 0 (22 bytes used): patient (20) + category (1) + isActive (1)
     *      Slot 1 (32 bytes used): uploadedBy (20) + createdAt (12)
     *      Slot 2: ipfsCID dynamic pointer
     *      Slot 3: encryptedKey dynamic pointer
     *
     *      Saves 2 SSTOREs per record vs the naïve layout (~40k gas).
     *      `createdAt` is uint96: max representable value is ~7.9 × 10^28,
     *      good for ~2.5 × 10^21 years of unix-seconds — safe.
     */
    struct HealthRecord {
        // ---- Slot 0 ----
        address patient;
        RecordCategory category;
        bool isActive;
        // ---- Slot 1 ----
        address uploadedBy;
        uint96 createdAt;
        // ---- Slots 2 & 3 (dynamic pointers) ----
        string ipfsCID;
        /// @dev AES-GCM symmetric key wrapped with the patient's OWN
        ///      public key, so the patient can re-derive it later when
        ///      they want to wrap it for a new doctor.
        bytes encryptedKey;
    }

    // ------------------------------------------------------------------
    // Named constants
    // ------------------------------------------------------------------

    /// @dev Maximum allowed length, in bytes, of an IPFS CID string.
    uint256 private constant MAX_CID_LENGTH = 100;

    /// @dev Safety cap on the patient-wrapped encrypted key blob. A
    ///      typical ECIES wrap of a 32-byte AES key is < 200 bytes;
    ///      2 KiB is generous headroom.
    uint256 private constant MAX_ENCRYPTED_KEY_LENGTH = 2048;

    // ------------------------------------------------------------------
    // Immutable external dependencies
    // ------------------------------------------------------------------

    IPatientRegistry public immutable patientRegistry;
    IConsentManager public immutable consentManager;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    /// @dev Monotonically-increasing record ID. ID 0 is reserved as a
    ///      "non-existent" sentinel — the first stored record has ID 1.
    uint256 private _recordCounter;

    /// @dev Global recordId → record map. Kept private; reads go through
    ///      the access-controlled view functions below.
    mapping(uint256 => HealthRecord) private records;

    /// @dev Per-patient list of their record IDs (insertion order).
    mapping(address => uint256[]) private patientRecordIds;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event RecordStored(
        address indexed patient,
        uint256 indexed recordId,
        RecordCategory category,
        string ipfsCID,
        uint256 timestamp
    );

    event RecordDeleted(
        address indexed patient,
        uint256 indexed recordId,
        uint256 timestamp
    );

    /// @notice On-chain audit-log entry, emitted whenever a doctor reads
    ///         a patient's record via {getRecordForDoctor} under a
    ///         normal, category-scoped consent.
    event RecordAccessed(
        address indexed patient,
        address indexed doctor,
        uint256 indexed recordId,
        uint256 timestamp
    );

    /// @notice On-chain audit-log entry emitted when a doctor reads a
    ///         record under an active emergency-access flag instead of
    ///         a normal consent. The audit UI MUST distinguish these
    ///         from {RecordAccessed} — emergency reads typically warrant
    ///         additional review.
    event EmergencyRecordAccessed(
        address indexed patient,
        address indexed doctor,
        uint256 indexed recordId,
        uint256 timestamp
    );

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    modifier onlyRegisteredPatient() {
        // SECURITY: defer the role check to the canonical PatientRegistry
        // so this contract has a single source of truth for patient status.
        require(
            patientRegistry.isPatient(msg.sender),
            "HealthRecordStorage: caller is not a registered patient"
        );
        _;
    }

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Wires the storage contract to its registry/consent dependencies.
     */
    constructor(address _patientRegistry, address _consentManager)
        Ownable(msg.sender)
    {
        // SECURITY: reject zero-address dependencies — leaving either as
        // address(0) would brick every gated entry point.
        require(
            _patientRegistry != address(0),
            "HealthRecordStorage: zero patientRegistry"
        );
        require(
            _consentManager != address(0),
            "HealthRecordStorage: zero consentManager"
        );

        patientRegistry = IPatientRegistry(_patientRegistry);
        consentManager = IConsentManager(_consentManager);
    }

    // ------------------------------------------------------------------
    // External / public mutating functions
    // ------------------------------------------------------------------

    /**
     * @notice Store a new encrypted health record. Caller must be a
     *         registered patient. The CID points to the encrypted blob
     *         on IPFS; `encryptedKey` is the AES-GCM symmetric key that
     *         decrypts the blob, itself wrapped with the patient's own
     *         public key so they can later re-wrap it for doctors when
     *         consent is granted.
     *
     * @param  ipfsCID      IPFS content identifier of the encrypted record.
     * @param  category     Record category from {RecordCategory}.
     * @param  encryptedKey Patient-wrapped AES symmetric key.
     * @return recordId     Globally-unique ID assigned to the new record.
     *
     * @dev Emits {RecordStored}.
     */
    function storeRecord(
        string calldata ipfsCID,
        RecordCategory category,
        bytes calldata encryptedKey
    ) external onlyRegisteredPatient returns (uint256 recordId) {
        // SECURITY: bound input lengths to prevent unbounded gas costs
        // and storage bloat from oversized payloads.
        bytes memory cidBytes = bytes(ipfsCID);
        require(cidBytes.length > 0, "HealthRecordStorage: ipfsCID required");
        require(
            cidBytes.length <= MAX_CID_LENGTH,
            "HealthRecordStorage: ipfsCID too long"
        );
        require(
            encryptedKey.length > 0,
            "HealthRecordStorage: encryptedKey required"
        );
        require(
            encryptedKey.length <= MAX_ENCRYPTED_KEY_LENGTH,
            "HealthRecordStorage: encryptedKey too long"
        );

        // Increment first so the first stored record gets ID 1, leaving
        // ID 0 as the "not found" sentinel everywhere else.
        unchecked {
            _recordCounter += 1;
        }
        recordId = _recordCounter;

        records[recordId] = HealthRecord({
            patient: msg.sender,
            category: category,
            isActive: true,
            uploadedBy: msg.sender,
            // Safe cast: uint96 covers ~2.5 × 10^21 years of unix-seconds.
            createdAt: uint96(block.timestamp),
            ipfsCID: ipfsCID,
            encryptedKey: encryptedKey
        });

        patientRecordIds[msg.sender].push(recordId);

        emit RecordStored(
            msg.sender,
            recordId,
            category,
            ipfsCID,
            block.timestamp
        );
    }

    /**
     * @notice Soft-delete one of the caller's own records by flipping
     *         its `isActive` flag to false. The record stays in storage
     *         so the deletion is auditable.
     *
     * @param  recordId The global record ID to delete.
     *
     * @dev Emits {RecordDeleted}.
     */
    function deleteRecord(uint256 recordId) external {
        HealthRecord storage record = records[recordId];

        // SECURITY: only the patient who owns the record may delete it.
        // Combined check (patient == msg.sender) rejects both "not your
        // record" and "record doesn't exist" cases (uninitialised
        // mapping entries have patient == address(0)).
        require(
            record.patient == msg.sender,
            "HealthRecordStorage: not your record"
        );
        require(
            record.isActive,
            "HealthRecordStorage: record already deleted"
        );

        record.isActive = false;

        emit RecordDeleted(msg.sender, recordId, block.timestamp);
    }

    /**
     * @notice Doctor read entry point. Returns the encrypted record's
     *         CID and a wrapped symmetric key, gated by either an
     *         active category-scoped consent OR an active emergency
     *         access flag in {ConsentManager}.
     *
     *         Non-view because it emits an audit-log event — the audit
     *         trail is the whole point of the function. Costs a small
     *         gas fee per access, which is the desired property: every
     *         doctor read is permanently recorded on-chain.
     *
     *         The `doctor` parameter is kept in the signature to match
     *         the API consumers expect; the function enforces
     *         `doctor == msg.sender` so the audit log cannot be spoofed.
     *
     *         The function prefers regular consent over emergency. When
     *         both are present, the regular path runs and {RecordAccessed}
     *         is emitted. When only emergency access is active, the
     *         function returns the patient-wrapped key (the doctor cannot
     *         decrypt without out-of-band patient cooperation, but the
     *         access is recorded) and emits {EmergencyRecordAccessed}.
     *
     * @param  recordId The global record ID to read.
     * @param  doctor   Must equal msg.sender.
     * @return ipfsCID    Encrypted record's CID.
     * @return wrappedKey Doctor-wrapped AES key when under regular consent,
     *                    or patient-wrapped key when under emergency access.
     *
     * @dev Emits {RecordAccessed} or {EmergencyRecordAccessed}.
     */
    function getRecordForDoctor(uint256 recordId, address doctor)
        external
        returns (string memory ipfsCID, bytes memory wrappedKey)
    {
        // SECURITY: prevent third-party calls from polluting the audit
        // log with arbitrary doctor addresses.
        require(
            doctor == msg.sender,
            "HealthRecordStorage: doctor must equal caller"
        );

        HealthRecord storage record = records[recordId];
        require(
            record.patient != address(0),
            "HealthRecordStorage: record not found"
        );
        require(
            record.isActive,
            "HealthRecordStorage: record deleted"
        );

        // SECURITY: category-scoped consent — a doctor with consent for
        // BLOOD_TEST cannot read a MENTAL_HEALTH record from the same
        // patient. Emergency access falls back only when regular consent
        // is absent.
        bool hasRegular = consentManager.hasAccessForCategory(
            record.patient,
            doctor,
            uint8(record.category)
        );
        bool hasEmergency =
            !hasRegular &&
            consentManager.hasEmergencyAccess(record.patient, doctor);
        require(
            hasRegular || hasEmergency,
            "HealthRecordStorage: no consent and no emergency access"
        );

        ipfsCID = record.ipfsCID;

        if (hasRegular) {
            wrappedKey = consentManager.getDoctorWrappedKey(
                record.patient,
                doctor,
                uint8(record.category)
            );
            emit RecordAccessed(
                record.patient,
                doctor,
                recordId,
                block.timestamp
            );
        } else {
            // Emergency path: doctor receives the patient-wrapped key.
            // Cannot decrypt directly — requires out-of-band patient
            // cooperation in practice. The audit log is the primary
            // mechanism here.
            wrappedKey = record.encryptedKey;
            emit EmergencyRecordAccessed(
                record.patient,
                doctor,
                recordId,
                block.timestamp
            );
        }
    }

    // ------------------------------------------------------------------
    // External / public view functions
    // ------------------------------------------------------------------

    /**
     * @notice Fetch a single record by ID.
     * @param  recordId Global record ID to read.
     * @return The {HealthRecord} struct.
     * @dev Reverts with "No access permission" if the caller is neither
     *      the patient nor a holder of an active (legacy, catch-all)
     *      consent. Doctors should prefer {getRecordForDoctor} so the
     *      access is audited and category-scoped.
     */
    function getRecord(uint256 recordId)
        external
        view
        returns (HealthRecord memory)
    {
        HealthRecord storage record = records[recordId];
        require(
            record.patient != address(0),
            "HealthRecordStorage: record not found"
        );
        require(_hasReadAccess(record.patient), "No access permission");
        return record;
    }

    /**
     * @notice Returns the full record list (active and deleted) for a
     *         given patient.
     * @param  patient Address whose records are being requested.
     * @return Array of {HealthRecord} entries in storage order.
     * @dev Reverts with "No access permission" if the caller is neither
     *      the patient nor a holder of an active (legacy, catch-all)
     *      consent.
     */
    function getRecords(address patient)
        external
        view
        returns (HealthRecord[] memory)
    {
        require(_hasReadAccess(patient), "No access permission");
        uint256[] storage ids = patientRecordIds[patient];
        uint256 count = ids.length;
        HealthRecord[] memory result = new HealthRecord[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = records[ids[i]];
        }
        return result;
    }

    /**
     * @notice Returns only the records whose `isActive` flag is true.
     * @param  patient Address whose active records are being requested.
     * @return Filtered array of active {HealthRecord} entries.
     */
    function getActiveRecords(address patient)
        external
        view
        returns (HealthRecord[] memory)
    {
        require(_hasReadAccess(patient), "No access permission");
        uint256[] storage ids = patientRecordIds[patient];
        uint256 count = ids.length;

        uint256 activeCount = 0;
        for (uint256 i = 0; i < count; i++) {
            if (records[ids[i]].isActive) {
                activeCount++;
            }
        }

        HealthRecord[] memory result = new HealthRecord[](activeCount);
        uint256 j = 0;
        for (uint256 i = 0; i < count; i++) {
            if (records[ids[i]].isActive) {
                result[j++] = records[ids[i]];
            }
        }
        return result;
    }

    /**
     * @notice Returns the list of record IDs owned by `patient`.
     * @param  patient Address whose record IDs are being requested.
     * @return Array of global record IDs in insertion order.
     */
    function getRecordIdsForPatient(address patient)
        external
        view
        returns (uint256[] memory)
    {
        require(_hasReadAccess(patient), "No access permission");
        return patientRecordIds[patient];
    }

    /**
     * @notice Total number of records ever stored across all patients.
     *         Useful aggregate for the admin panel; reveals only a
     *         count, not record contents.
     * @return The current value of the global record counter.
     */
    function totalRecordCount() external view returns (uint256) {
        return _recordCounter;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * @dev Legacy read-access check used by the patient-self-access and
     *      catch-all-consent read paths. Category-scoped reads MUST go
     *      through {getRecordForDoctor} so they hit the audit log.
     */
    function _hasReadAccess(address patient) internal view returns (bool) {
        if (msg.sender == patient) {
            return true;
        }
        return consentManager.hasAccess(patient, msg.sender);
    }
}
