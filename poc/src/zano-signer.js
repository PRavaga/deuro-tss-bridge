// Zano Signing Module
//
// Handles signing and broadcasting Zano asset transactions.
// For EVM -> Zano direction: creates emit (mint) transaction, signs with TSS, broadcasts.
//
// Bridgeless ref:
//   tss-svc/internal/tss/session/signing/zano/session.go (signing session)
//   tss-svc/internal/tss/session/signing/zano/finalizer.go (broadcast)
//   tss-svc/pkg/zano/utils.go (signature encoding)

import { ethers } from 'ethers';
import { config } from './config.js';
import {
  emitAsset,
  sendExtSignedAssetTx,
  formSigningData,
  encodeSignatureForZano,
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
 * Sign the Zano transaction hash with this party's key.
 *
 * In the PoC: signs with the party's ECDSA key directly.
 * In production: 2-of-3 TSS signing produces a single combined signature.
 *
 * The message to sign is the raw transaction ID bytes.
 *
 * Bridgeless ref:
 *   tss-svc/pkg/zano/utils.go FormSigningData() -- forms the message
 *   tss-svc/internal/tss/signer.go Run() -- TSS signing
 */
export async function signZanoTxHash(sigData) {
  if (!config.partyKeys) {
    throw new Error('Party keys not loaded. Run keygen.js first.');
  }

  const myKey = config.partyKeys[config.partyId];
  if (!myKey) {
    throw new Error(`No key found for party ${config.partyId}`);
  }

  // Create wallet from party's key
  const wallet = new ethers.Wallet(myKey.privateKey);

  // Zano expects the raw tx_id (32-byte hash) to be signed directly with ECDSA.
  // No keccak256 or Ethereum prefix — the tx_id IS the digest.
  //
  // Ref: zano/utils/JS/test_eth_sig.js:
  //   const bytesToSign = ethers.getBytes('0x' + verified_tx_id);
  //   const signature = wallet.signingKey.sign(bytesToSign).serialized;
  const signingKey = new ethers.SigningKey(myKey.privateKey);

  // sigData may arrive as a serialized Buffer object ({ type: "Buffer", data: [...] })
  // after JSON transport through P2P. Normalize it to Uint8Array.
  let normalizedSigData;
  if (sigData && sigData.type === 'Buffer' && Array.isArray(sigData.data)) {
    normalizedSigData = new Uint8Array(sigData.data);
  } else if (typeof sigData === 'string') {
    normalizedSigData = ethers.getBytes('0x' + sigData.replace(/^0x/, ''));
  } else {
    normalizedSigData = sigData;
  }

  // Sign the raw 32-byte tx_id directly (it IS the digest, no additional hashing)
  const sig = signingKey.sign(normalizedSigData);

  return {
    signature: sig.serialized,           // 65 bytes: r + s + v
    r: sig.r,
    s: sig.s,
    v: sig.v,
    signer: wallet.address,
  };
}

/**
 * Broadcast a signed Zano transaction.
 * Only the session leader calls this.
 *
 * Bridgeless ref: tss-svc/internal/tss/session/signing/zano/finalizer.go Finalize()
 *
 * Flow:
 * 1. Encode the TSS signature for Zano format
 * 2. Call send_ext_signed_asset_tx with the unsigned tx, finalized tx, and signature
 * 3. Zano wallet applies the signature and broadcasts
 */
export async function broadcastSignedZanoTx(unsignedTxData, signature) {
  // Encode signature for Zano's format
  // Bridgeless ref: tss-svc/pkg/zano/utils.go EncodeSignature()
  const zanoSig = encodeSignatureForZano(signature);

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
 *
 * This is the leader's perspective. Non-leaders just sign and return.
 *
 * Bridgeless ref: tss-svc/internal/tss/session/signing/zano/session.go runSession()
 */
export async function processZanoWithdrawal(deposit) {
  const assetId = config.zano.assetId;
  const receiver = deposit.receiver;
  const amount = deposit.amount;

  // 1. Create unsigned transaction
  const unsignedTxData = await createUnsignedEmitTx(assetId, receiver, amount);

  // 2. Sign the tx hash
  const mySig = await signZanoTxHash(unsignedTxData.sigData);

  // Return signing data for consensus exchange
  return {
    unsignedTxData,
    signature: mySig,
  };
}
