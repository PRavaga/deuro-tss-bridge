#!/usr/bin/env node

// Helper: Make a deposit on Zano side (burn tokens to bridge to EVM)
//
// Usage:
//   node src/deposit-zano.js <evm-address> <amount>
//
// This burns the dEURO asset on Zano using `transfer` RPC with service_entries
// containing the EVM destination address. The burn transaction includes:
//   { dst_add: "0x...", dst_net_id: "evm" }
//
// The bridge parties detect this burn+memo and mint dEURO on EVM.

import { config } from './config.js';
import { transferWithBurn } from './zano-rpc.js';

async function main() {
  const evmAddress = process.argv[2];
  const amount = process.argv[3] ?? '1000000000000'; // 1 dEURO (12 decimals)

  if (!evmAddress) {
    console.log('Usage: node src/deposit-zano.js <evm-address> [amount]');
    console.log('Example: node src/deposit-zano.js 0x742d35Cc... 1000000000000');
    process.exit(1);
  }

  if (!config.zano.assetId) {
    console.error('ZANO_ASSET_ID not set. Configure the Zano asset first.');
    process.exit(1);
  }

  // Validate EVM address
  if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) {
    console.error('Invalid EVM address format');
    process.exit(1);
  }

  console.log(`Burning ${amount} of asset ${config.zano.assetId} on Zano`);
  console.log(`  Destination: ${evmAddress} (EVM)`);

  try {
    const result = await transferWithBurn(config.zano.assetId, amount, evmAddress);
    console.log('Transfer result:', JSON.stringify(result, null, 2));
    console.log();
    console.log('Burn with memo submitted. Parties will detect this and mint dEURO on EVM.');
  } catch (err) {
    console.error('Transfer failed:', err.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
