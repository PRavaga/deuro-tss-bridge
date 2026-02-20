// Zano Signing Module
//
// Handles signing and broadcasting Zano asset transactions using TSS.
// For EVM -> Zano direction: creates emit (mint) transaction, signs with TSS, broadcasts.
//
// With TSS, 2-of-3 parties cooperate to produce a single ECDSA signature.
// The combined (R, S) is sent to Zano as r+s hex (no recovery byte V).
//
// Bridgeless ref:
//   tss-svc/internal/tss/session/signing/zano/session.go (signing session)
//   tss-svc/internal/tss/session/signing/zano/finalizer.go (broadcast)
//   tss-svc/pkg/zano/utils.go (signature encoding)

import { config } from './config.js';
import { distributedSign, formatZanoSignature } from './tss.js';
import {
  emitAsset,
  sendExtSignedAssetTx,
  formSigningData,
} from './zano-rpc.js';

/**
 * Create an unsigned Zano emit (mint) transaction.
 * This is called by the session leader during the proposal phase.
 *
 * Bridgeless ref: tss-svc/internal/bridge/chain/zano/withdraw.go EmitAssetUnsigned()
 *
 * Returns the data needed for TSS signing and later broadcast.
 */
export async function createUnsignedEmitTx(assetId, receiverAddress, amount) {
  console.log(`[Zano Signer] Creating unsigned emit: ${amount} of ${assetId} to ${receiverAddress}`);

  const result = await emitAsset(assetId, receiverAddress, amount);

  if (!result || !result.data_for_external_signing) {
    throw new Error('Failed to create unsigned emit transaction');
  }

  return {
    txId: result.tx_id,
    unsignedTx: result.data_for_external_signing.unsigned_tx,
    finalizedTx: result.data_for_external_signing.finalized_tx,
    outputsAddresses: result.data_for_external_signing.outputs_addresses,
    txSecretKey: result.data_for_external_signing.tx_secret_key,
    sigData: formSigningData(result.tx_id),
  };
}

/**
 * Sign the Zano transaction hash using TSS cooperative signing.
 *
 * 2-of-3 parties run the DKLs23 signing protocol to produce a single
 * combined ECDSA signature. No party ever holds the full private key.
 *
 * The message to sign is the raw transaction ID bytes (32-byte hash).
 * No keccak256 or Ethereum prefix — the tx_id IS the digest.
 *
 * @param {Buffer|Uint8Array} sigData  The 32-byte tx_id to sign
 * @param {Function} sendMsg           P2P send for TSS rounds
 * @param {Function} waitForMsgs       P2P receive for TSS rounds
 * @returns {{ r: Uint8Array, s: Uint8Array, zanoSig: string }}
 */
export async function signZanoTxHash(sigData, sendMsg, waitForMsgs) {
  if (!config.tssKeyshare) {
    throw new Error('TSS keyshare not loaded. Run keygen.js first.');
  }

  // Normalize sigData to Uint8Array
  let normalizedSigData;
  if (sigData && sigData.type === 'Buffer' && Array.isArray(sigData.data)) {
    normalizedSigData = new Uint8Array(sigData.data);
  } else if (typeof sigData === 'string') {
    normalizedSigData = new Uint8Array(Buffer.from(sigData.replace(/^0x/, ''), 'hex'));
  } else {
    normalizedSigData = new Uint8Array(sigData);
  }

  // Run TSS signing protocol (6 rounds with co-signer)
  // sigData IS the digest — Zano signs the raw tx_id directly
  const { r, s } = await distributedSign(config.tssKeyshare, normalizedSigData, sendMsg, waitForMsgs);

  // Format for Zano: r+s hex (128 chars, no V, no 0x prefix)
  const zanoSig = formatZanoSignature(r, s);

  return { r, s, zanoSig };
}

/**
 * Broadcast a signed Zano transaction.
 * Only the session leader calls this.
 *
 * Bridgeless ref: tss-svc/internal/tss/session/signing/zano/finalizer.go Finalize()
 *
 * @param {Object} unsignedTxData  From createUnsignedEmitTx()
 * @param {string} zanoSig         r+s hex from TSS signing (128 chars)
 */
export async function broadcastSignedZanoTx(unsignedTxData, zanoSig) {
  console.log(`[Zano Signer] Broadcasting signed tx: ${unsignedTxData.txId}`);

  const result = await sendExtSignedAssetTx(
    zanoSig,
    unsignedTxData.txId,
    unsignedTxData.finalizedTx,
    unsignedTxData.unsignedTx,
  );

  if (result.status !== 'OK') {
    throw new Error(`Zano broadcast failed: ${result.status}`);
  }

  console.log(`[Zano Signer] Transaction broadcast successfully: ${unsignedTxData.txId}`);
  return unsignedTxData.txId;
}

/**
 * Full Zano signing flow for a single deposit (EVM -> Zano).
 * Leader creates unsigned tx, both signers run TSS, leader broadcasts.
 *
 * Bridgeless ref: tss-svc/internal/tss/session/signing/zano/session.go runSession()
 *
 * @param {Object} deposit       The deposit to process
 * @param {Function} sendMsg     P2P send for TSS rounds
 * @param {Function} waitForMsgs P2P receive for TSS rounds
 */
export async function processZanoWithdrawal(deposit, sendMsg, waitForMsgs) {
  const assetId = config.zano.assetId;
  const receiver = deposit.receiver;
  const amount = deposit.amount;

  // 1. Create unsigned transaction
  const unsignedTxData = await createUnsignedEmitTx(assetId, receiver, amount);

  // 2. Sign the tx hash via TSS
  const tssSig = await signZanoTxHash(unsignedTxData.sigData, sendMsg, waitForMsgs);

  // Return signing data for broadcast
  return {
    unsignedTxData,
    zanoSig: tssSig.zanoSig,
  };
}
