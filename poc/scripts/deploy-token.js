#!/usr/bin/env node

// Deploy DeuroToken ERC20 contract and grant MINTER_ROLE to bridge
//
// Usage:
//   DEPLOYER_PRIVATE_KEY=0x... EVM_RPC=https://... BRIDGE_ADDRESS=0x... \
//     npx hardhat run scripts/deploy-token.js --network sepolia
//
// Steps:
//   1. Deploy DeuroToken with 1,000,000 dEURO initial supply
//   2. Grant MINTER_ROLE to bridge contract (so bridge can mint on withdrawal)
//   3. Print token address for config

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying DeuroToken...');
  console.log(`  Deployer: ${deployer.address}`);

  const bridgeAddress = process.env.BRIDGE_ADDRESS;
  if (!bridgeAddress) {
    console.error('BRIDGE_ADDRESS not set. Deploy DeuroBridge first.');
    process.exit(1);
  }

  // 1,000,000 dEURO with 12 decimals = 1_000_000 * 10^12
  const initialSupply = ethers.parseUnits('1000000', 12);

  const DeuroToken = await ethers.getContractFactory('DeuroToken');
  const token = await DeuroToken.deploy(initialSupply);
  await token.waitForDeployment();

  const tokenAddress = await token.getAddress();
  console.log(`  DeuroToken deployed to: ${tokenAddress}`);
  console.log(`  Initial supply: 1,000,000 dEURO (${initialSupply} atomic)`);
  console.log(`  Decimals: 12`);

  // Grant MINTER_ROLE to bridge
  const MINTER_ROLE = await token.MINTER_ROLE();
  const grantTx = await token.grantRole(MINTER_ROLE, bridgeAddress);
  await grantTx.wait();
  console.log(`  MINTER_ROLE granted to bridge: ${bridgeAddress}`);

  console.log();
  console.log('Set this in your config:');
  console.log(`  DEURO_TOKEN=${tokenAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
