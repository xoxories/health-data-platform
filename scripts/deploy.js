const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const FRONTEND_CONFIG_PATH = path.join(
  __dirname,
  "..",
  "frontend",
  "src",
  "config",
  "contract.js"
);

const SEPARATOR = "=".repeat(60);

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Deploy a contract by name with the given constructor args, wait for
 * the deployment to be mined, log the result and return the deployed
 * Contract instance, its on-chain address, and the block number in
 * which the deployment transaction was mined.
 */
async function deployContract(name, args = []) {
  console.log(`Deploying ${name}...`);
  const Factory = await hre.ethers.getContractFactory(name);
  const contract = await Factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  // Capture the deploy block. Useful as a fromBlock floor for any
  // queryFilter call against this contract — RPC providers like Alchemy
  // cap eth_getLogs to a 50k-block window, so callers can't safely
  // default to fromBlock=0.
  const deployTx = contract.deploymentTransaction();
  const receipt = deployTx ? await deployTx.wait() : null;
  const deployBlock = receipt ? receipt.blockNumber : null;

  console.log(`  ${name} deployed to: ${address}`);
  return { contract, address, deployBlock };
}

/**
 * Renders the auto-generated frontend config file.
 */
function renderFrontendConfig({ network, deployBlock, addresses, abis }) {
  return `// AUTO-GENERATED FILE — do not edit by hand.
// Regenerated each time scripts/deploy.js runs.
//
// Network    : ${network}
// Generated  : ${new Date().toISOString()}

export const PATIENT_REGISTRY_ADDRESS = "${addresses.patientRegistry}";
export const CONSENT_MANAGER_ADDRESS = "${addresses.consentManager}";
export const HEALTH_RECORD_STORAGE_ADDRESS = "${addresses.healthRecordStorage}";

// Block number in which the last contract (HealthRecordStorage) was
// deployed. Use as a fromBlock floor for queryFilter calls so they
// don't blow past the RPC provider's eth_getLogs window.
export const DEPLOY_BLOCK = ${deployBlock ?? "null"};

export const PatientRegistryABI = ${JSON.stringify(abis.patientRegistry, null, 2)};

export const ConsentManagerABI = ${JSON.stringify(abis.consentManager, null, 2)};

export const HealthRecordStorageABI = ${JSON.stringify(abis.healthRecordStorage, null, 2)};
`;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  try {
    const [deployer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(deployer.address);

    console.log(SEPARATOR);
    console.log("Deploying Health Data Platform contracts");
    console.log(SEPARATOR);
    console.log("Network :", hre.network.name);
    console.log("Deployer:", deployer.address);
    console.log("Balance :", hre.ethers.formatEther(balance), "ETH");

    // Warn (don't throw) on a zero-balance live deploy. Hardhat-local
    // deploys hit pre-funded accounts and never trip this; for testnets,
    // testnet ETH is finite and noisy faucet flow means we'd rather log
    // and let the user decide than block on a flap.
    if (balance === 0n && hre.network.name !== "hardhat") {
      console.warn(
        "[deploy] WARNING: deployer has zero balance on this network. Fund the wallet via a faucet before retrying if the next tx fails."
      );
    }
    console.log();

    // 1. PatientRegistry — no constructor args.
    const { address: patientRegistryAddress } = await deployContract(
      "PatientRegistry"
    );

    // 2. ConsentManager — depends on PatientRegistry.
    const { address: consentManagerAddress } = await deployContract(
      "ConsentManager",
      [patientRegistryAddress]
    );

    // 3. HealthRecordStorage — depends on both. Capture this contract's
    // deploy block as the canonical DEPLOY_BLOCK floor for the frontend.
    const {
      address: healthRecordStorageAddress,
      deployBlock: lastDeployBlock,
    } = await deployContract("HealthRecordStorage", [
      patientRegistryAddress,
      consentManagerAddress,
    ]);

    // Summary table.
    console.log();
    console.log(SEPARATOR);
    console.log("Deployment summary");
    console.log(SEPARATOR);
    const summary = [
      ["Network", hre.network.name],
      ["PatientRegistry", patientRegistryAddress],
      ["ConsentManager", consentManagerAddress],
      ["HealthRecordStorage", healthRecordStorageAddress],
    ];
    const labelWidth = Math.max(...summary.map(([k]) => k.length));
    for (const [label, value] of summary) {
      console.log(`  ${label.padEnd(labelWidth)}  ${value}`);
    }
    console.log();

    // Write addresses + ABIs to the frontend config so the React app
    // always has the latest addresses after a redeploy.
    const [patientRegistryArtifact, consentManagerArtifact, healthRecordStorageArtifact] =
      await Promise.all([
        hre.artifacts.readArtifact("PatientRegistry"),
        hre.artifacts.readArtifact("ConsentManager"),
        hre.artifacts.readArtifact("HealthRecordStorage"),
      ]);

    const fileContent = renderFrontendConfig({
      network: hre.network.name,
      deployBlock: lastDeployBlock,
      addresses: {
        patientRegistry: patientRegistryAddress,
        consentManager: consentManagerAddress,
        healthRecordStorage: healthRecordStorageAddress,
      },
      abis: {
        patientRegistry: patientRegistryArtifact.abi,
        consentManager: consentManagerArtifact.abi,
        healthRecordStorage: healthRecordStorageArtifact.abi,
      },
    });

    fs.mkdirSync(path.dirname(FRONTEND_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(FRONTEND_CONFIG_PATH, fileContent);

    console.log(`Wrote frontend config to: ${FRONTEND_CONFIG_PATH}`);
    console.log();
    console.log("Deployment complete!");
  } catch (error) {
    console.error();
    console.error("Deployment failed:");
    console.error(error);
    process.exitCode = 1;
    throw error;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(() => process.exit(1));
