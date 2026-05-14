# Health Data Sharing Platform

A decentralized application (dApp) for securely sharing health data between patients
and healthcare providers, built on the Ethereum Sepolia testnet.

## Tech Stack

- **Smart Contracts:** Solidity ^0.8.20
- **Development Framework:** Hardhat
- **Frontend:** React.js (Vite) + TailwindCSS
- **Web3 Library:** ethers.js v5
- **Off-chain Storage:** IPFS (via Pinata)
- **Network:** Ethereum Sepolia Testnet

## Project Structure

```
health-data-platform/
├── contracts/              # Solidity smart contracts
│   ├── PatientRegistry.sol
│   ├── HealthRecordStorage.sol
│   └── ConsentManager.sol
├── scripts/                # Deployment scripts
│   └── deploy.js
├── test/                   # Contract test suites
├── frontend/               # React + Vite frontend
│   └── src/
│       ├── config/         # Contract addresses & ABIs
│       ├── hooks/          # Custom React hooks
│       ├── components/     # UI components
│       └── utils/          # IPFS helpers, etc.
├── hardhat.config.js
└── package.json
```

## Smart Contracts

| Contract              | Purpose                                                    |
| --------------------- | ---------------------------------------------------------- |
| `PatientRegistry`     | Registers patients and doctors and manages their identity. |
| `HealthRecordStorage` | Stores IPFS hashes of health records on-chain.             |
| `ConsentManager`      | Manages access permissions between patients and doctors.   |

## Getting Started

### 1. Install dependencies

```bash
# Root (Hardhat)
npm install

# Frontend
cd frontend
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in:

- `SEPOLIA_RPC_URL` (from Alchemy or Infura)
- `PRIVATE_KEY` (deployer wallet — never commit a real key)
- `ETHERSCAN_API_KEY`
- Pinata credentials for IPFS

### 3. Compile contracts

```bash
npm run compile
```

### 4. Run tests

```bash
npm test
```

### 5. Deploy

```bash
# Local Hardhat node
npm run node                # in one terminal
npm run deploy:local        # in another

# Sepolia
npm run deploy:sepolia
```

Copy the deployed addresses into `frontend/.env` (or root `.env` with the
`VITE_*` keys).

### 6. Run the frontend

```bash
cd frontend
npm run dev
```

## License

MIT
