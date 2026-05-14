// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// =====================================================================
// External interface
// =====================================================================

interface IPatientRegistry {
    function isPatient(address account) external view returns (bool);
    function isDoctor(address account) external view returns (bool);
}

// =====================================================================
// ConsentManager
// =====================================================================

/**
 * @title  ConsentManager
 * @notice Manages patient → doctor data-access consents for the Health
 *         Data Sharing Platform. Doctors initiate access requests and
 *         patients explicitly grant or revoke them, scoped per record
 *         category and bound by an optional expiry.
 *
 *         Per-category wrapped-key design: when a patient grants
 *         access, they supply ONE wrapped symmetric-key blob per
 *         category they're granting. The wrapped key is the
 *         category-level master encrypted with the doctor's public key.
 *         The doctor uses that single wrapped blob to derive per-record
 *         keys client-side. This keeps on-chain storage bounded (n
 *         categories per grant rather than n records) at a security
 *         cost: a single wrapped blob covers every record in that
 *         category for the consent's lifetime. Per-record wrapping
 *         would be stricter but is bytecode-prohibitive — design
 *         decision documented for the security report.
 *
 *         Also supports an emergency-access ("break-glass") flag any
 *         registered doctor may invoke. It grants a 24-hour read flag
 *         regardless of consent, recorded on-chain, and only the
 *         patient can clear it.
 */
contract ConsentManager is Ownable, ReentrancyGuard {
    // ------------------------------------------------------------------
    // Named constants (no magic numbers)
    // ------------------------------------------------------------------

    /// @dev Seconds in one day.
    uint256 private constant SECONDS_PER_DAY = 1 days;

    /// @dev Hard upper bound on consent `expiryDays` to reject obviously
    ///      nonsensical inputs (~27 years).
    uint256 private constant MAX_EXPIRY_DAYS = 10_000;

    /// @dev Sentinel meaning "no expiry — permanent until revoked".
    uint256 private constant NO_EXPIRY = 0;

    /// @dev Duration of an emergency-access window from the moment it
    ///      is invoked.
    uint256 private constant EMERGENCY_DURATION = 24 hours;

    /// @dev Total number of valid {RecordCategory} values. Mirrors the
    ///      enum in HealthRecordStorage. If the enum grows past 8
    ///      values, bump `categoryBitmap` to uint16 and update this.
    uint8 private constant CATEGORY_COUNT = 7;

    /// @dev Maximum allowed length of a reason string passed to
    ///      {emergencyAccess}. Prevents storage-bloat / event-spam DoS.
    uint256 private constant MAX_REASON_LENGTH = 200;

    /// @dev Maximum allowed length of a single wrapped-key blob.
    ///      Matches the matching cap in {HealthRecordStorage}.
    uint256 private constant MAX_WRAPPED_KEY_LENGTH = 2048;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /**
     * @dev Per (patient, doctor) consent record. Fields ordered for
     *      single-slot packing: 12 + 12 + 1 + 1 = 26 bytes < 32.
     */
    struct Consent {
        uint96 grantedAt;
        /// @dev `expiresAt == 0` means no expiry (permanent until revoked).
        uint96 expiresAt;
        /// @dev Bit `i` set ⇒ category `i` is granted. Up to 8 categories.
        uint8 categoryBitmap;
        bool isActive;
    }

    // ------------------------------------------------------------------
    // Immutable external dependencies
    // ------------------------------------------------------------------

    /// @notice PatientRegistry used to verify patient and doctor roles.
    IPatientRegistry public immutable patientRegistry;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    /// @dev patient => doctor => Consent.
    mapping(address => mapping(address => Consent)) private consents;

    /// @dev patient => doctor => category => wrapped-key blob.
    mapping(address => mapping(address => mapping(uint8 => bytes)))
        private doctorWrappedKeys;

    /// @dev patient => doctor => emergency-access expiry timestamp.
    ///      0 means no active emergency access.
    mapping(address => mapping(address => uint96))
        private emergencyAccessExpiresAt;

    /// @dev patient => list of doctors with an outstanding access request.
    mapping(address => address[]) private accessRequests;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event AccessRequested(
        address indexed patient,
        address indexed doctor,
        uint256 timestamp
    );

    event AccessGranted(
        address indexed patient,
        address indexed doctor,
        uint8 categoryBitmap,
        uint256 expiresAt,
        uint256 timestamp
    );

    event AccessRevoked(
        address indexed patient,
        address indexed doctor,
        uint256 timestamp
    );

    /// @notice Emitted when a doctor invokes break-glass emergency
    ///         access on a patient. Permanent audit record; emergency
    ///         access cannot be retroactively rescinded.
    event EmergencyAccessInvoked(
        address indexed doctor,
        address indexed patient,
        string reason,
        uint256 timestamp
    );

    /// @notice Emitted when a patient clears an active emergency-access
    ///         flag for a doctor.
    event EmergencyAccessCleared(
        address indexed patient,
        address indexed doctor,
        uint256 timestamp
    );

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Wires the consent manager to its patient registry.
     * @param  _patientRegistry Address of the deployed {PatientRegistry}.
     */
    constructor(address _patientRegistry) Ownable(msg.sender) {
        // SECURITY: reject zero address — every gated entry point
        // depends on the registry; address(0) would brick the contract.
        require(
            _patientRegistry != address(0),
            "ConsentManager: zero patientRegistry"
        );
        patientRegistry = IPatientRegistry(_patientRegistry);
    }

    // ------------------------------------------------------------------
    // External / public mutating functions
    // ------------------------------------------------------------------

    /**
     * @notice Doctor entry point: request access to a patient's records.
     * @param  patient Address of the patient whose data is being requested.
     *
     * @dev Requirements:
     *      - Caller must be a registered doctor.
     *      - `patient` must be a registered patient.
     *      - Caller must not already have a pending request for this
     *        patient.
     *
     *      Emits an {AccessRequested} event.
     *
     *      // SECURITY: ReentrancyGuard — `patientRegistry` is an
     *      // external contract.
     */
    function requestAccess(address patient) external nonReentrant {
        require(
            patientRegistry.isDoctor(msg.sender),
            "ConsentManager: caller is not a registered doctor"
        );
        require(
            patientRegistry.isPatient(patient),
            "ConsentManager: target is not a registered patient"
        );
        require(
            !_isRequestPending(patient, msg.sender),
            "ConsentManager: access request already pending"
        );

        accessRequests[patient].push(msg.sender);

        emit AccessRequested(patient, msg.sender, block.timestamp);
    }

    /**
     * @notice Patient entry point: grant a doctor category-scoped access
     *         with optional expiry, storing one doctor-wrapped symmetric
     *         key per granted category. REPLACES any prior consent from
     *         the same patient to the same doctor.
     * @param  doctor      Address of the doctor being granted access.
     * @param  categories  Categories to grant. Each entry is the
     *                     {RecordCategory} ordinal as uint8.
     * @param  expiryDays  Days until the consent expires. 0 = permanent.
     * @param  wrappedKeys Parallel array to `categories`: one
     *                     doctor-wrapped key blob per category.
     *
     * @dev Requirements:
     *      - Caller must be a registered patient.
     *      - `doctor` must be a registered doctor.
     *      - `expiryDays` must be ≤ {MAX_EXPIRY_DAYS}.
     *      - `categories` and `wrappedKeys` must be the same non-zero
     *        length.
     *      - Each category index must be < {CATEGORY_COUNT}.
     *      - Each wrapped key must be non-empty and within
     *        {MAX_WRAPPED_KEY_LENGTH}.
     *
     *      Emits an {AccessGranted} event.
     *
     *      // SECURITY: ReentrancyGuard + CEI — all external reads
     *      // happen in the Checks phase; only event emission follows
     *      // the Effects phase.
     */
    function grantAccess(
        address doctor,
        uint8[] calldata categories,
        uint256 expiryDays,
        bytes[] calldata wrappedKeys
    ) external nonReentrant {
        // -------- Checks --------
        require(
            patientRegistry.isPatient(msg.sender),
            "ConsentManager: caller is not a registered patient"
        );
        require(
            patientRegistry.isDoctor(doctor),
            "ConsentManager: target is not a registered doctor"
        );
        require(
            expiryDays <= MAX_EXPIRY_DAYS,
            "ConsentManager: expiryDays exceeds maximum"
        );
        require(
            categories.length > 0,
            "ConsentManager: at least one category required"
        );
        require(
            categories.length == wrappedKeys.length,
            "ConsentManager: categories/keys length mismatch"
        );

        uint8 bitmap = 0;
        for (uint256 i = 0; i < categories.length; i++) {
            uint8 cat = categories[i];
            require(
                cat < CATEGORY_COUNT,
                "ConsentManager: invalid category"
            );
            require(
                wrappedKeys[i].length > 0,
                "ConsentManager: wrapped key required"
            );
            require(
                wrappedKeys[i].length <= MAX_WRAPPED_KEY_LENGTH,
                "ConsentManager: wrapped key too long"
            );
            bitmap |= uint8(1 << cat);
        }

        // SECURITY: Integer overflow protected by Solidity ^0.8.x.
        // MAX_EXPIRY_DAYS bound keeps the multiplication well within
        // uint96, so the cast is safe.
        uint96 expiresAt = expiryDays == NO_EXPIRY
            ? uint96(NO_EXPIRY)
            : uint96(block.timestamp + (expiryDays * SECONDS_PER_DAY));

        // -------- Effects --------
        consents[msg.sender][doctor] = Consent({
            grantedAt: uint96(block.timestamp),
            expiresAt: expiresAt,
            categoryBitmap: bitmap,
            isActive: true
        });

        for (uint256 i = 0; i < categories.length; i++) {
            doctorWrappedKeys[msg.sender][doctor][categories[i]] =
                wrappedKeys[i];
        }

        _removePendingRequest(msg.sender, doctor);

        // -------- Interactions --------
        emit AccessGranted(
            msg.sender,
            doctor,
            bitmap,
            expiresAt,
            block.timestamp
        );
    }

    /**
     * @notice Patient entry point: revoke a previously granted consent.
     * @param  doctor Address of the doctor whose access is being revoked.
     *
     * @dev Requirements:
     *      - Caller must currently have an active consent for `doctor`
     *        (idempotency guard).
     *
     *      Emits an {AccessRevoked} event. Wrapped-key blobs remain in
     *      storage but become unreachable through the access-checked
     *      view: re-granting will overwrite them.
     */
    function revokeAccess(address doctor) external {
        Consent storage c = consents[msg.sender][doctor];
        require(
            c.isActive,
            "ConsentManager: no active consent to revoke"
        );

        c.isActive = false;

        emit AccessRevoked(msg.sender, doctor, block.timestamp);
    }

    /**
     * @notice Doctor break-glass entry point. Grants the caller a
     *         24-hour emergency read-access flag for the given patient,
     *         regardless of any existing consent. Permanently logged
     *         on-chain.
     * @param  patient The patient whose data the doctor is accessing
     *                 under emergency.
     * @param  reason  Short justification, e.g. "Patient unconscious in
     *                 ER, allergy lookup". Required, non-empty.
     *
     * @dev Requirements:
     *      - Caller must be a registered doctor.
     *      - `patient` must be a registered patient.
     *      - `reason` must be non-empty and ≤ {MAX_REASON_LENGTH} bytes.
     *
     *      Emits an {EmergencyAccessInvoked} event — this audit record
     *      is permanent.
     *
     *      // SECURITY: ReentrancyGuard — external registry calls.
     */
    function emergencyAccess(address patient, string calldata reason)
        external
        nonReentrant
    {
        require(
            patientRegistry.isDoctor(msg.sender),
            "ConsentManager: caller is not a registered doctor"
        );
        require(
            patientRegistry.isPatient(patient),
            "ConsentManager: target is not a registered patient"
        );

        bytes memory reasonBytes = bytes(reason);
        require(reasonBytes.length > 0, "ConsentManager: reason required");
        require(
            reasonBytes.length <= MAX_REASON_LENGTH,
            "ConsentManager: reason too long"
        );

        // Effects: extend or set the emergency window.
        emergencyAccessExpiresAt[patient][msg.sender] =
            uint96(block.timestamp + EMERGENCY_DURATION);

        emit EmergencyAccessInvoked(
            msg.sender,
            patient,
            reason,
            block.timestamp
        );
    }

    /**
     * @notice Patient entry point: clear an active emergency-access
     *         flag for `doctor`. The {EmergencyAccessInvoked} record
     *         remains in the event log permanently — clearing only
     *         removes the read flag going forward.
     * @param  doctor The doctor whose emergency access is being cleared.
     *
     * @dev Requirements:
     *      - Caller must currently have an active emergency-access flag
     *        for `doctor`.
     *
     *      Emits an {EmergencyAccessCleared} event.
     */
    function clearEmergencyAccess(address doctor) external {
        require(
            emergencyAccessExpiresAt[msg.sender][doctor] != 0,
            "ConsentManager: no active emergency access"
        );
        emergencyAccessExpiresAt[msg.sender][doctor] = 0;

        emit EmergencyAccessCleared(msg.sender, doctor, block.timestamp);
    }

    // ------------------------------------------------------------------
    // External / public view functions
    // ------------------------------------------------------------------

    /**
     * @notice Returns whether `doctor` has any currently-active
     *         (category-scoped) consent from `patient`. Used as the
     *         legacy catch-all access check by {HealthRecordStorage}'s
     *         non-audited read paths.
     * @param  patient Address of the patient.
     * @param  doctor  Address of the doctor.
     * @return True iff consent is active, not expired, and grants at
     *         least one category.
     */
    function hasAccess(address patient, address doctor)
        external
        view
        returns (bool)
    {
        Consent storage c = consents[patient][doctor];
        if (!c.isActive) return false;
        if (c.expiresAt != NO_EXPIRY && block.timestamp >= c.expiresAt) {
            return false;
        }
        return c.categoryBitmap != 0;
    }

    /**
     * @notice Returns whether `doctor` currently has access to
     *         `patient`'s records of the given `category` under a
     *         regular (non-emergency) consent.
     * @param  patient  Address of the patient.
     * @param  doctor   Address of the doctor.
     * @param  category Category index (must be < {CATEGORY_COUNT}).
     * @return True iff the consent is active, not expired, and the
     *         category bit is set.
     */
    function hasAccessForCategory(
        address patient,
        address doctor,
        uint8 category
    ) external view returns (bool) {
        require(
            category < CATEGORY_COUNT,
            "ConsentManager: invalid category"
        );
        Consent storage c = consents[patient][doctor];
        if (!c.isActive) return false;
        if (c.expiresAt != NO_EXPIRY && block.timestamp >= c.expiresAt) {
            return false;
        }
        return (c.categoryBitmap & uint8(1 << category)) != 0;
    }

    /**
     * @notice Returns whether `doctor` currently has an active
     *         emergency-access flag for `patient`.
     * @param  patient Address of the patient.
     * @param  doctor  Address of the doctor.
     * @return True iff an emergency window is set and has not expired.
     */
    function hasEmergencyAccess(address patient, address doctor)
        external
        view
        returns (bool)
    {
        uint96 expiresAt = emergencyAccessExpiresAt[patient][doctor];
        if (expiresAt == 0) return false;
        return block.timestamp < expiresAt;
    }

    /**
     * @notice Returns the doctor-wrapped key blob for a (patient,
     *         doctor, category) tuple, if one was stored at grant time.
     * @param  patient  Address of the patient.
     * @param  doctor   Address of the doctor.
     * @param  category Category index.
     * @return The opaque wrapped-key bytes (empty if never granted).
     *
     * @dev Returns the stored blob regardless of consent state — the
     *      caller ({HealthRecordStorage}) gates on
     *      {hasAccessForCategory} before invoking this view.
     */
    function getDoctorWrappedKey(
        address patient,
        address doctor,
        uint8 category
    ) external view returns (bytes memory) {
        return doctorWrappedKeys[patient][doctor][category];
    }

    /**
     * @notice Fetches the full consent record between `patient` and
     *         `doctor`.
     * @param  patient Address of the patient.
     * @param  doctor  Address of the doctor.
     * @return The {Consent} struct (zero-valued if never granted).
     */
    function getConsent(address patient, address doctor)
        external
        view
        returns (Consent memory)
    {
        return consents[patient][doctor];
    }

    /**
     * @notice Returns the unix timestamp at which the active emergency
     *         flag for (patient, doctor) expires, or 0 if none.
     * @param  patient Address of the patient.
     * @param  doctor  Address of the doctor.
     * @return Expiry timestamp (seconds since unix epoch), or 0.
     */
    function getEmergencyAccessExpiry(address patient, address doctor)
        external
        view
        returns (uint96)
    {
        return emergencyAccessExpiresAt[patient][doctor];
    }

    /**
     * @notice Returns the list of doctors with an outstanding access
     *         request for `patient`.
     * @param  patient Address of the patient.
     * @return Array of doctor addresses awaiting a grant decision.
     */
    function getPendingRequests(address patient)
        external
        view
        returns (address[] memory)
    {
        return accessRequests[patient];
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * @dev Returns true if `doctor` is already in `patient`'s pending
     *      request list. O(n) over a typically small list.
     */
    function _isRequestPending(address patient, address doctor)
        internal
        view
        returns (bool)
    {
        address[] storage list = accessRequests[patient];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == doctor) {
                return true;
            }
        }
        return false;
    }

    /**
     * @dev Removes `doctor` from `patient`'s pending request list, if
     *      present, using swap-with-last + pop. No-op if not present.
     */
    function _removePendingRequest(address patient, address doctor)
        internal
    {
        address[] storage list = accessRequests[patient];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == doctor) {
                list[i] = list[len - 1];
                list.pop();
                return;
            }
        }
    }
}
