require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");
require("hardhat-gas-reporter");
require("hardhat-contract-sizer");

// ---------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------

const ALCHEMY_SEPOLIA_URL = process.env.ALCHEMY_SEPOLIA_URL || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const COINMARKETCAP_API_KEY = process.env.COINMARKETCAP_API_KEY || "";

// CI / fresh-clone friendliness: warn but never throw, so `npx hardhat
// compile` and `npx hardhat test` still work on the in-process Hardhat
// network without any secrets configured.
if (!PRIVATE_KEY) {
  console.warn(
    "[hardhat.config] PRIVATE_KEY is not set in .env — live-network deployments are disabled. Compile and local tests will still work."
  );
}

if (!ALCHEMY_SEPOLIA_URL) {
  console.warn(
    "[hardhat.config] ALCHEMY_SEPOLIA_URL is not set in .env — Sepolia network is disabled."
  );
}

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {},
    sepolia: {
      url: ALCHEMY_SEPOLIA_URL,
      chainId: 11155111,
      // If PRIVATE_KEY is missing we pass [] so Hardhat does not try to
      // parse `undefined` as a key. The sepolia network simply has no
      // accounts in that case and any deploy attempt fails cleanly.
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
  gasReporter: {
    enabled: true,
    currency: "USD",
    outputFile: "gas-report.txt",
    noColors: true,
    coinmarketcap: COINMARKETCAP_API_KEY,
  },
};
