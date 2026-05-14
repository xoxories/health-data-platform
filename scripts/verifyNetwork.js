const hre = require("hardhat");

const EXPECTED_CHAIN_ID = 11155111n;

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  console.log("Network name :", hre.network.name);
  console.log("Chain ID     :", network.chainId.toString());

  const [signer] = await hre.ethers.getSigners();
  if (!signer) {
    throw new Error(
      "No signer available. Check PRIVATE_KEY in .env and the network's accounts config in hardhat.config.js."
    );
  }
  console.log("Deployer     :", signer.address);

  const balance = await hre.ethers.provider.getBalance(signer.address);
  console.log("Balance      :", hre.ethers.formatEther(balance), "ETH");

  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Wrong network. Expected chainId ${EXPECTED_CHAIN_ID}, got ${network.chainId}. Check ALCHEMY_SEPOLIA_URL in .env.`
    );
  }

  if (balance === 0n) {
    throw new Error(
      `Deployer ${signer.address} has 0 ETH. Fund it from a Sepolia faucet before deploying.`
    );
  }

  console.log("OK — network and balance verified.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
