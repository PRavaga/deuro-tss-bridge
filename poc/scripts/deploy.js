// Deploy DeuroBridge to Sepolia testnet
//
// Usage:
//   npx hardhat run scripts/deploy.js --network sepolia
//
// Prerequisites:
//   1. Run `node src/keygen.js` first to generate party keys
//   2. Set DEPLOYER_PRIVATE_KEY in .env or environment
//   3. Fund the deployer account with Sepolia ETH

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Load party keys
  const keysPath = join(__dirname, '..', 'data', 'party-keys.json');
  let partyKeys;
  try {
    partyKeys = JSON.parse(readFileSync(keysPath, 'utf8'));
  } catch {
    console.error('Party keys not found. Run `node src/keygen.js` first.');
    process.exit(1);
  }

  const signerAddresses = partyKeys.map(p => p.address);
  const threshold = 2; // 2-of-3

  console.log('Deploying DeuroBridge...');
  console.log(`  Signers: ${signerAddresses.join(', ')}`);
  console.log(`  Threshold: ${threshold}`);
  console.log();

  const DeuroBridge = await ethers.getContractFactory('DeuroBridge');
  const bridge = await DeuroBridge.deploy(signerAddresses, threshold);
  await bridge.waitForDeployment();

  const address = await bridge.getAddress();
  console.log(`DeuroBridge deployed to: ${address}`);
  console.log();
  console.log('Set this in your config:');
  console.log(`  BRIDGE_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
