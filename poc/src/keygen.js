#!/usr/bin/env node

// Key Generation for deuro TSS Bridge PoC
//
// Generates 3 ECDSA keypairs -- one per party.
// In production, this would be replaced by a TSS distributed key generation
// ceremony using bnb-chain/tss-lib, where no single party ever holds the full key.
//
// For the PoC, each party holds their own standard ECDSA key.
// The Bridge.sol contract verifies 2-of-3 signatures on-chain.

import { Wallet } from 'ethers';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

function main() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const outputPath = join(DATA_DIR, 'party-keys.json');

  if (existsSync(outputPath)) {
    console.log('Keys already exist at:', outputPath);
    console.log('Delete the file to regenerate.');
    process.exit(0);
  }

  console.log('Generating 3 ECDSA keypairs for bridge parties...\n');

  const parties = [];

  for (let i = 0; i < 3; i++) {
    const wallet = Wallet.createRandom();
    parties.push({
      id: i,
      name: `Party ${String.fromCharCode(65 + i)}`,
      address: wallet.address,
      privateKey: wallet.privateKey,
      publicKey: wallet.publicKey,
    });
    console.log(`  Party ${String.fromCharCode(65 + i)}:`);
    console.log(`    Address:    ${wallet.address}`);
    console.log(`    Public Key: ${wallet.publicKey}`);
    console.log();
  }

  // Save all keys (in production, each party would only have their own share)
  writeFileSync(outputPath, JSON.stringify(parties, null, 2));
  console.log('Keys saved to:', outputPath);
  console.log();

  // Print addresses for Bridge.sol deployment
  const addresses = parties.map(p => p.address);
  console.log('For Bridge.sol deployment, use these signer addresses:');
  console.log(`  Signers:   [${addresses.map(a => `"${a}"`).join(', ')}]`);
  console.log(`  Threshold: 2`);
  console.log();

  // Print the TSS note
  console.log('NOTE: In production with TSS, all 3 parties would share a SINGLE');
  console.log('Ethereum address (derived from the TSS group public key). The bridge');
  console.log('contract would have threshold=1 since TSS produces a single valid');
  console.log('signature. The 2-of-3 threshold is enforced off-chain by the TSS protocol.');
}

main();
