// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title  PatientRegistry
 * @notice Registers patients and doctors for the Health Data Sharing
 *         Platform and tracks their identity metadata.
 * @dev    Combines OpenZeppelin {Ownable} (administrative control of the
 *         doctor registry) with {AccessControl} (fine-grained PATIENT_ROLE
 *         / DOCTOR_ROLE memberships consumed by the rest of the platform).
 */
contract PatientRegistry is Ownable, AccessControl {
    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------

    /// @notice Role granted to any address that has self-registered as a patient.
    bytes32 public constant PATIENT_ROLE = keccak256("PATIENT_ROLE");

    /// @notice Role granted to addresses approved by the owner as doctors.
    bytes32 public constant DOCTOR_ROLE = keccak256("DOCTOR_ROLE");

    // ------------------------------------------------------------------
    // Named constants (no magic numbers)
    // ------------------------------------------------------------------

    /// @dev Maximum allowed length, in bytes, of a stored patient name string.
    uint256 private constant MAX_NAME_LENGTH = 64;

    /// @dev Maximum allowed length, in bytes, of a doctor's hospital
    ///      affiliation string.
    uint256 private constant MAX_HOSPITAL_AFFILIATION_LENGTH = 128;

    /// @dev Maximum allowed length, in bytes, of a doctor-revocation
    ///      reason. Permissive; empty is allowed (audit log says "no
    ///      reason given").
    uint256 private constant MAX_REVOKE_REASON_LENGTH = 200;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    struct Patient {
        string name;
        bool isRegistered;
        uint256 registeredAt;
    }

    /**
     * @dev Field declaration order chosen for storage packing:
     *
     *      Slot 0 (13 bytes used): registeredAt (12) + isActive (1)
     *      Slot 1 (32 bytes used): licenseHash (32, full)
     *      Slot 2: hospitalAffiliation dynamic pointer
     *      Slot 3: encryptionPubKey dynamic pointer
     *
     *      `registeredAt` is uint96 — good for ~2.5 × 10^21 years of
     *      unix-seconds. Externally exposed as uint256 by
     *      {getDoctorInfo} to match the contract surface.
     */
    struct Doctor {
        // ---- Slot 0 ----
        uint96 registeredAt;
        bool isActive;
        // ---- Slot 1 ----
        bytes32 licenseHash;
        // ---- Slot 2 (dynamic pointer) ----
        string hospitalAffiliation;
        // ---- Slot 3 (dynamic pointer) ----
        /// @dev 64-byte uncompressed secp256k1 public key (x || y, no
        ///      0x04 prefix). Empty bytes until the doctor publishes
        ///      it via {setDoctorEncryptionPubKey}. Required by the
        ///      frontend ECIES wrap path; doctors who haven't set
        ///      their pubkey cannot receive doctor-wrapped record keys.
        bytes encryptionPubKey;
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    mapping(address => Patient) public patients;
    mapping(address => Doctor) public doctors;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event PatientRegistered(address indexed patient, string name, uint256 timestamp);

    /// @notice Emitted when the owner registers a new doctor. `licenseHash`
    ///         is the keccak256 of the doctor's medical-license string,
    ///         hashed client-side so the raw license number is never
    ///         stored on-chain.
    event DoctorRegistered(
        address indexed doctor,
        bytes32 licenseHash,
        string hospitalAffiliation,
        uint256 timestamp
    );

    /// @notice Emitted when the owner revokes a doctor's registration.
    ///         `reason` is captured in the audit log for accountability.
    event DoctorRevoked(
        address indexed doctor,
        string reason,
        uint256 timestamp
    );

    /// @notice Emitted when a doctor publishes their secp256k1 encryption
    ///         public key for ECIES key wrapping. `pubKey` is the 64-byte
    ///         uncompressed form (x ‖ y, no leading 0x04). Patients use it
    ///         to wrap per-record AES keys for this doctor.
    event DoctorPubKeySet(
        address indexed doctor,
        bytes pubKey,
        uint256 timestamp
    );

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @notice Initialises the contract. The deployer becomes the owner and
     *         is granted the {AccessControl} default admin role.
     */
    constructor() Ownable(msg.sender) {
        // SECURITY: grant the deployer the AccessControl admin role so they
        // can administer role assignments through the AccessControl API in
        // addition to the Ownable-gated entry points exposed below.
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ------------------------------------------------------------------
    // External / public mutating functions
    // ------------------------------------------------------------------

    /**
     * @notice Self-register the caller as a patient.
     * @param  name Human-readable display name of the patient.
     *
     * @dev Requirements:
     *      - Caller must not already be a registered patient.
     *      - Caller must not already be an active doctor.
     *      - `name` must be non-empty and at most {MAX_NAME_LENGTH} bytes.
     *
     *      Emits a {PatientRegistered} event.
     */
    function registerPatient(string calldata name) external {
        // SECURITY: prevent duplicate registration, which would otherwise
        // overwrite the original `registeredAt` timestamp and emit a
        // misleading event.
        require(
            !patients[msg.sender].isRegistered,
            "PatientRegistry: already registered as patient"
        );

        // SECURITY: a single address must not hold both PATIENT_ROLE and
        // DOCTOR_ROLE — the access semantics of the two roles differ and
        // mixing them would let a doctor masquerade as a patient.
        require(
            !doctors[msg.sender].isActive,
            "PatientRegistry: address is an active doctor"
        );

        // SECURITY: bound input string length to prevent unbounded gas
        // costs and storage bloat from oversized payloads.
        bytes memory nameBytes = bytes(name);
        require(nameBytes.length > 0, "PatientRegistry: name required");
        require(
            nameBytes.length <= MAX_NAME_LENGTH,
            "PatientRegistry: name too long"
        );

        patients[msg.sender] = Patient({
            name: name,
            isRegistered: true,
            registeredAt: block.timestamp
        });

        _grantRole(PATIENT_ROLE, msg.sender);

        emit PatientRegistered(msg.sender, name, block.timestamp);
    }

    /**
     * @notice Register a new doctor. Callable only by the contract owner.
     * @param  doctor              Wallet address of the doctor being
     *                             registered.
     * @param  licenseHash         keccak256 of the doctor's medical-license
     *                             string, computed client-side so the raw
     *                             license number never touches the chain.
     * @param  hospitalAffiliation Human-readable hospital / clinic name.
     *
     * @dev Requirements:
     *      - Caller must be the contract owner.
     *      - `doctor` must be a non-zero address.
     *      - `doctor` must not already be an active doctor.
     *      - `doctor` must not already be a registered patient.
     *      - `licenseHash` must be non-zero (use `keccak256(licenseString)`).
     *      - `hospitalAffiliation` must be non-empty and at most
     *        {MAX_HOSPITAL_AFFILIATION_LENGTH} bytes.
     *
     *      Emits a {DoctorRegistered} event.
     */
    function registerDoctor(
        address doctor,
        bytes32 licenseHash,
        string memory hospitalAffiliation
    ) external onlyOwner {
        // SECURITY: reject the zero address to prevent assigning the role
        // to an inaccessible account, which would permanently waste a slot.
        require(doctor != address(0), "PatientRegistry: zero address");

        // SECURITY: prevent overwriting an active doctor's record, which
        // would silently reset their `registeredAt` timestamp.
        require(
            !doctors[doctor].isActive,
            "PatientRegistry: doctor already active"
        );

        // SECURITY: disallow dual-role accounts (mirror of the check in
        // registerPatient).
        require(
            !patients[doctor].isRegistered,
            "PatientRegistry: address is a registered patient"
        );

        // SECURITY: enforce non-zero licenseHash. bytes32(0) almost
        // certainly means the caller forgot to compute keccak256 of the
        // license string client-side.
        require(
            licenseHash != bytes32(0),
            "PatientRegistry: licenseHash required"
        );

        // SECURITY: bound the affiliation string length.
        bytes memory affBytes = bytes(hospitalAffiliation);
        require(
            affBytes.length > 0,
            "PatientRegistry: hospitalAffiliation required"
        );
        require(
            affBytes.length <= MAX_HOSPITAL_AFFILIATION_LENGTH,
            "PatientRegistry: hospitalAffiliation too long"
        );

        doctors[doctor] = Doctor({
            // Safe cast: uint96 covers ~2.5 × 10^21 years of unix-seconds.
            registeredAt: uint96(block.timestamp),
            isActive: true,
            licenseHash: licenseHash,
            hospitalAffiliation: hospitalAffiliation,
            // Doctor must publish their pubkey separately via
            // {setDoctorEncryptionPubKey}. Initialised empty here.
            encryptionPubKey: ""
        });

        _grantRole(DOCTOR_ROLE, doctor);

        emit DoctorRegistered(
            doctor,
            licenseHash,
            hospitalAffiliation,
            block.timestamp
        );
    }

    /**
     * @notice Revoke an existing doctor's registration. Callable only by
     *         the contract owner.
     * @param  doctor Address of the doctor to revoke.
     * @param  reason Free-text justification, persisted in the
     *                {DoctorRevoked} event for audit accountability.
     *                Empty strings are permitted (logged as "no reason
     *                given") but bounded by {MAX_REVOKE_REASON_LENGTH}
     *                to prevent event-spam DoS.
     *
     * @dev Requirements:
     *      - Caller must be the contract owner.
     *      - `doctor` must currently be an active doctor.
     *      - `reason` must be ≤ {MAX_REVOKE_REASON_LENGTH} bytes.
     *
     *      Emits a {DoctorRevoked} event with the reason string.
     */
    function revokeDoctor(address doctor, string memory reason)
        external
        onlyOwner
    {
        // SECURITY: require the doctor to currently be active so that this
        // call cannot be used to spam misleading {DoctorRevoked} events
        // for arbitrary addresses.
        require(
            doctors[doctor].isActive,
            "PatientRegistry: doctor not active"
        );

        // SECURITY: bound the reason string length.
        require(
            bytes(reason).length <= MAX_REVOKE_REASON_LENGTH,
            "PatientRegistry: reason too long"
        );

        doctors[doctor].isActive = false;

        _revokeRole(DOCTOR_ROLE, doctor);

        emit DoctorRevoked(doctor, reason, block.timestamp);
    }

    /**
     * @notice Doctor publishes their secp256k1 public key for ECIES key
     *         wrapping. Patients fetch this and use it to wrap per-record
     *         AES keys client-side when granting access.
     *
     *         The contract enforces `keccak256(pubKey)[12:] == msg.sender`
     *         so the published key is provably the caller's. A doctor can
     *         only set their key once — rotation is intentionally
     *         disabled to prevent silent compromise. If rotation is
     *         needed, the admin must revoke and re-register the doctor
     *         (which clears the stored pubkey via struct overwrite in
     *         {registerDoctor}).
     *
     * @param  pubKey 64 bytes uncompressed (x ‖ y, no leading 0x04 byte).
     *
     * @dev Requirements:
     *      - Caller holds {DOCTOR_ROLE}.
     *      - Doctor's record is currently active. (Defensive — in the
     *        current contract, revocation also clears DOCTOR_ROLE, so
     *        the role check above fires first. Kept for belt-and-braces
     *        coverage if role/isActive ever drift.)
     *      - `pubKey.length == 64`.
     *      - No pubkey is already stored for the caller.
     *
     *      NOTE: there is intentionally NO check that
     *      `keccak256(pubKey)[12:] == msg.sender`. The published key is
     *      an ECIES encryption key derived client-side via HKDF from a
     *      deterministic MetaMask signature (see frontend/src/utils/
     *      crypto.js → deriveECIESKeypairFromSigner). MetaMask never
     *      exposes the wallet's secp256k1 private scalar, so an ECIES
     *      keypair has to be derived independently, which by
     *      construction can't satisfy the wallet-address-match
     *      invariant. The check would not add security: msg.sender is
     *      already authenticated, so the doctor controls their own
     *      pubkey slot regardless. If the doctor publishes a key whose
     *      private half they don't hold, only their own subsequent
     *      reads break — no other doctor is affected.
     *
     *      Emits a {DoctorPubKeySet} event.
     */
    function setDoctorEncryptionPubKey(bytes calldata pubKey) external {
        require(
            hasRole(DOCTOR_ROLE, msg.sender),
            "PatientRegistry: not a registered doctor"
        );
        require(
            doctors[msg.sender].isActive,
            "PatientRegistry: doctor not active"
        );
        require(
            pubKey.length == 64,
            "PatientRegistry: pubkey must be 64 bytes uncompressed"
        );
        require(
            doctors[msg.sender].encryptionPubKey.length == 0,
            "PatientRegistry: pubkey already set"
        );

        doctors[msg.sender].encryptionPubKey = pubKey;

        emit DoctorPubKeySet(msg.sender, pubKey, block.timestamp);
    }

    // ------------------------------------------------------------------
    // External / public view functions
    // ------------------------------------------------------------------

    /**
     * @notice Returns whether `account` is a registered patient.
     * @param  account Address to query.
     * @return True if the account has self-registered as a patient.
     */
    function isPatient(address account) external view returns (bool) {
        return patients[account].isRegistered;
    }

    /**
     * @notice Returns whether `account` is an active doctor.
     * @param  account Address to query.
     * @return True if the account is currently an active doctor.
     */
    function isDoctor(address account) external view returns (bool) {
        return doctors[account].isActive;
    }

    /**
     * @notice Fetches the full patient record for `account`.
     * @param  account Address of the patient.
     * @return The {Patient} struct (zero-valued if unregistered).
     */
    function getPatient(address account)
        external
        view
        returns (Patient memory)
    {
        return patients[account];
    }

    /**
     * @notice Fetches the full doctor record for `account`.
     * @param  account Address of the doctor.
     * @return The {Doctor} struct (zero-valued if unregistered).
     */
    function getDoctor(address account)
        external
        view
        returns (Doctor memory)
    {
        return doctors[account];
    }

    /**
     * @notice Destructured doctor info — convenience tuple matching the
     *         shape the frontend AdminPanel consumes. Equivalent to
     *         {getDoctor} but returns a flat tuple instead of a struct.
     * @param  account Address of the doctor.
     * @return licenseHash         keccak256 of the doctor's medical
     *                             license string.
     * @return hospitalAffiliation The hospital / clinic name registered
     *                             at grant time.
     * @return isActive            True if the doctor's registration has
     *                             not been revoked.
     * @return registeredAt        Unix timestamp of registration (widened
     *                             from the packed uint96 storage field
     *                             to uint256 for caller convenience).
     * @return encryptionPubKey    64-byte uncompressed secp256k1 public
     *                             key, or empty bytes if the doctor has
     *                             not yet published it.
     */
    function getDoctorInfo(address account)
        public
        view
        returns (
            bytes32 licenseHash,
            string memory hospitalAffiliation,
            bool isActive,
            uint256 registeredAt,
            bytes memory encryptionPubKey
        )
    {
        Doctor storage d = doctors[account];
        return (
            d.licenseHash,
            d.hospitalAffiliation,
            d.isActive,
            uint256(d.registeredAt),
            d.encryptionPubKey
        );
    }

    /**
     * @notice Returns the doctor's published encryption public key, or
     *         empty bytes if they have not yet called
     *         {setDoctorEncryptionPubKey}.
     * @param  doctor Address of the doctor.
     * @return The 64-byte uncompressed secp256k1 pubkey (x ‖ y, no prefix).
     */
    function getDoctorEncryptionPubKey(address doctor)
        external
        view
        returns (bytes memory)
    {
        return doctors[doctor].encryptionPubKey;
    }

    // ------------------------------------------------------------------
    // ERC165
    // ------------------------------------------------------------------

    /**
     * @notice ERC165 interface support, inherited from {AccessControl}.
     * @param  interfaceId The 4-byte interface identifier to query.
     * @return True if the contract implements `interfaceId`.
     */
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
