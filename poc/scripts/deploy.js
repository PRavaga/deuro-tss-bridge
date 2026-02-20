// Deploy DeuroBridge to Sepolia testnet (TSS mode)
//
// TSS deployment: single group address, threshold=1.
// The 2-of-3 threshold is enforced off-chain by the DKLs23 protocol.
//
// Usage:
//   npx hardhat run scripts/deploy.js --network sepolia
//
// Prerequisites:
//   1. Run DKG ceremony first: PARTY_ID=x node src/keygen.js (all 3 parties)
//   2. Set DEPLOYER_PRIVATE_KEY in .env or environment
//   3. Fund the deployer account with Sepolia ETH

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Load any keyshare to derive the group address (all keyshares produce the same address)
  let keyshareFile = null;
  for (let i = 0; i < 3; i++) {
    const path = join(__dirname, '..', 'data', `keyshare-${i}.bin`);
    if (existsSync(path)) {
      keyshareFile = path;
      break;
    }
  }

  if (!keyshareFile) {
    console.error('No keyshare files found. Run DKG ceremony first:');
    console.error('  PARTY_ID=0 node src/keygen.js  (terminal 1)');
    console.error('  PARTY_ID=1 node src/keygen.js  (terminal 2)');
    console.error('  PARTY_ID=2 node src/keygen.js  (terminal 3)');
    process.exit(1);
  }

  // Initialize WASM and derive group address
  const { initTss, getGroupAddress } = await import('../src/tss.js');
  await initTss();

  const keyshareBytes = readFileSync(keyshareFile);
  const groupAddress = getGroupAddress(keyshareBytes);

  // TSS: single signer (group address), threshold=1
  // The 2-of-3 threshold is enforced by the DKLs23 protocol off-chain
  const signerAddresses = [groupAddress];
  const threshold = 1;

  console.log('Deploying DeuroBridge (TSS mode)...');
  console.log(`  Group Address: ${groupAddress}`);
  console.log(`  Signers: [${groupAddress}]`);
  console.log(`  On-chain Threshold: ${threshold} (TSS enforces 2-of-3 off-chain)`);
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
