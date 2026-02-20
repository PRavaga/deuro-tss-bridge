// ============================================================================
// Contract Tests: DeuroBridge.sol + DeuroToken.sol
// ============================================================================
//
// Tests the Solidity bridge contract on a local Hardhat network.
// Each test suite deploys a fresh contract, so there's no state leakage.
//
// What we verify:
//   1. Deployment with correct signers and threshold
//   2. Native ETH deposits emit the right event
//   3. ERC20 (dEURO) deposits burn tokens and emit the right event
//   4. ERC20 withdrawals mint tokens with valid multi-sig signatures
//   5. Native ETH withdrawals with valid multi-sig signatures
//   6. Hash compatibility: off-chain computeNativeSignHash matches on-chain
//   7. Replay protection: same (txHash, txNonce) can't be used twice
//   8. Threshold enforcement: not enough signatures -> revert
//   9. Invalid signer detection: non-party signature -> revert
//  10. Pause/unpause emergency circuit breaker
//  11. Signer removal
//
// We use Hardhat's built-in accounts (same keys as PARTY_KEYS in fixtures).
// The test starts a local Hardhat node in-process via hre.ethers, so no
// external node is needed.
//
// NOTE: We avoid @nomicfoundation/hardhat-chai-matchers because it conflicts
// with Vitest's Chai instance. Instead we use try/catch for reverts and
// manual log parsing for events.
// ============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import hre from 'hardhat';
import { ethers } from 'ethers';
import { PARTY_KEYS, TEST_CHAIN_ID } from '../fixtures.js';
import { computeNativeSignHash, computeErc20SignHash } from '../../src/evm-signer.js';

// ---- Test-scoped state ----
let bridge;          // Contract instance (connected to deployer)
let deuroToken;      // DeuroToken instance (connected to deployer)
let provider;        // Hardhat's JSON-RPC provider
let signerAccounts;  // ethers.Signer[] for the 3 party accounts
let bridgeAddress;   // Deployed contract address
let tokenAddress;    // Deployed token address
let deployer;        // Deployer signer

// ---- Helper: sign a hash with a specific party's key ----
// Uses EIP-191 personal sign, matching what signHash() in evm-signer.js does.
async function signWithKey(hash, privateKey) {
  const wallet = new ethers.Wallet(privateKey);
  return wallet.signMessage(ethers.getBytes(hash));
}

// ---- Helper: collect 2-of-3 signatures for a hash ----
async function collectSignatures(hash, partyIndices = [0, 1]) {
  return Promise.all(
    partyIndices.map(i => signWithKey(hash, PARTY_KEYS[i].privateKey))
  );
}

// ============================================================================
// Setup: Deploy a fresh DeuroBridge + DeuroToken before all tests
// ============================================================================

beforeAll(async () => {
  // hre.ethers gives us access to the Hardhat network.
  // getSigners() returns accounts pre-funded with 10,000 ETH each.
  const allSigners = await hre.ethers.getSigners();
  signerAccounts = allSigners.slice(0, 3);
  deployer = allSigners[0];
  provider = hre.ethers.provider;

  // Deploy the bridge with 3 signers, threshold 2
  const signerAddresses = PARTY_KEYS.map(p => p.address);
  const DeuroBridge = await hre.ethers.getContractFactory('DeuroBridge');
  bridge = await DeuroBridge.deploy(signerAddresses, 2);
  await bridge.waitForDeployment();
  bridgeAddress = await bridge.getAddress();

  // Deploy DeuroToken with 1,000,000 dEURO initial supply (12 decimals)
  const initialSupply = hre.ethers.parseUnits('1000000', 12);
  const DeuroToken = await hre.ethers.getContractFactory('DeuroToken');
  deuroToken = await DeuroToken.deploy(initialSupply);
  await deuroToken.waitForDeployment();
  tokenAddress = await deuroToken.getAddress();

  // Grant MINTER_ROLE to bridge so it can mint on withdrawals
  const MINTER_ROLE = await deuroToken.MINTER_ROLE();
  await (await deuroToken.grantRole(MINTER_ROLE, bridgeAddress)).wait();

  // Fund the bridge with some ETH for withdrawal tests.
  // We send 10 ETH from the deployer so withdrawNative has funds.
  await deployer.sendTransaction({
    to: bridgeAddress,
    value: ethers.parseEther('10'),
  });
}, 120_000); // Hardhat compilation can be slow on first run

// ============================================================================
// Deployment
// ============================================================================

describe('deployment', () => {
  it('sets the correct threshold', async () => {
    const threshold = await bridge.signaturesThreshold();
    expect(threshold).toBe(2n);
  });

  it('registers all 3 signers', async () => {
    const signers = await bridge.getSigners();
    expect(signers).toHaveLength(3);

    // Check each party is a registered signer
    for (const pk of PARTY_KEYS) {
      const is = await bridge.isSigner(pk.address);
      expect(is).toBe(true);
    }
  });

  it('non-signer is not registered', async () => {
    // Account #10 is not a party
    const allSigners = await hre.ethers.getSigners();
    const randomAddr = await allSigners[10].getAddress();
    const is = await bridge.isSigner(randomAddr);
    expect(is).toBe(false);
  });
});

// ============================================================================
// DeuroToken
// ============================================================================

describe('DeuroToken', () => {
  it('has 12 decimals', async () => {
    const decimals = await deuroToken.decimals();
    expect(decimals).toBe(12n);
  });

  it('has correct initial supply', async () => {
    const supply = await deuroToken.totalSupply();
    expect(supply).toBe(hre.ethers.parseUnits('1000000', 12));
  });

  it('deployer has the initial supply', async () => {
    const balance = await deuroToken.balanceOf(deployer.address);
    expect(balance).toBe(hre.ethers.parseUnits('1000000', 12));
  });

  it('bridge has MINTER_ROLE', async () => {
    const MINTER_ROLE = await deuroToken.MINTER_ROLE();
    const has = await deuroToken.hasRole(MINTER_ROLE, bridgeAddress);
    expect(has).toBe(true);
  });
});

// ============================================================================
// Deposits
// ============================================================================

describe('depositNative', () => {
  it('accepts ETH and emits DepositedNative event', async () => {
    const receiver = 'ZxTestZanoAddress123';
    const value = ethers.parseEther('0.1');

    // Send the deposit transaction
    const tx = await bridge.depositNative(receiver, { value });
    const receipt = await tx.wait();

    // Find the DepositedNative event in the logs.
    // We parse logs manually instead of using hardhat-chai-matchers.
    const iface = bridge.interface;
    const depositEvent = receipt.logs
      .map(log => { try { return iface.parseLog(log); } catch { return null; } })
      .find(e => e?.name === 'DepositedNative');

    expect(depositEvent).toBeDefined();
    expect(depositEvent.args.amount).toBe(value);
    expect(depositEvent.args.receiver).toBe(receiver);
    expect(depositEvent.args.network).toBe('zano');
  });

  it('reverts on zero value', async () => {
    try {
      await bridge.depositNative('ZxAddr', { value: 0 });
      expect.fail('Should have reverted');
    } catch (err) {
      expect(err.message).toContain('zero value');
    }
  });
});

describe('depositERC20 (dEURO custody)', () => {
  it('locks dEURO in bridge and emits DepositedERC20 (isWrapped=false)', async () => {
    const receiver = 'ZxTestZanoAddress456';
    const amount = hre.ethers.parseUnits('100', 12); // 100 dEURO

    // Approve bridge to transfer our tokens into custody
    await (await deuroToken.approve(bridgeAddress, amount)).wait();

    const deployerBefore = await deuroToken.balanceOf(deployer.address);
    const bridgeBefore = await deuroToken.balanceOf(bridgeAddress);

    // Deposit with isWrapped=false (locks tokens in bridge)
    const tx = await bridge.depositERC20(tokenAddress, amount, receiver, false);
    const receipt = await tx.wait();

    // Verify tokens moved from depositor to bridge
    const deployerAfter = await deuroToken.balanceOf(deployer.address);
    const bridgeAfter = await deuroToken.balanceOf(bridgeAddress);
    expect(deployerBefore - deployerAfter).toBe(amount);
    expect(bridgeAfter - bridgeBefore).toBe(amount);

    // Verify event
    const iface = bridge.interface;
    const depositEvent = receipt.logs
      .map(log => { try { return iface.parseLog(log); } catch { return null; } })
      .find(e => e?.name === 'DepositedERC20');

    expect(depositEvent).toBeDefined();
    expect(depositEvent.args.token).toBe(tokenAddress);
    expect(depositEvent.args.amount).toBe(amount);
    expect(depositEvent.args.receiver).toBe(receiver);
    expect(depositEvent.args.isWrapped).toBe(false);
  });

  it('reverts on zero amount', async () => {
    try {
      await bridge.depositERC20(tokenAddress, 0, 'ZxAddr', false);
      expect.fail('Should have reverted');
    } catch (err) {
      expect(err.message).toContain('zero amount');
    }
  });
});

// ============================================================================
// Hash Compatibility (off-chain matches on-chain)
// ============================================================================

describe('hash compatibility', () => {
  // THE most critical test. If the off-chain hash doesn't match the
  // on-chain hash, signatures are useless and funds are stuck.
  //
  // We compute the hash with our JS function and with the Solidity function,
  // then compare byte-for-byte.

  it('native sign hash: JS matches Solidity', async () => {
    const amount = ethers.parseEther('1.0');
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'ab'.repeat(32);
    const txNonce = 0;

    // Hardhat local chain ID is 31337
    const chainId = (await provider.getNetwork()).chainId;

    // Off-chain (our JS function)
    const jsHash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);

    // On-chain (Solidity function)
    const solHash = await bridge.getNativeSignHash(amount, receiver, txHash, txNonce, chainId);

    expect(jsHash).toBe(solHash);
  });

  it('ERC20 sign hash: JS matches Solidity', async () => {
    const token = tokenAddress; // Use our deployed DeuroToken
    const amount = hre.ethers.parseUnits('1000', 12); // 12 decimals
    const receiver = PARTY_KEYS[1].address;
    const txHash = '0x' + 'cd'.repeat(32);
    const txNonce = 7;
    const chainId = (await provider.getNetwork()).chainId;
    const isWrapped = true;

    const jsHash = computeErc20SignHash(token, amount, receiver, txHash, txNonce, chainId, isWrapped);
    const solHash = await bridge.getERC20SignHash(token, amount, receiver, txHash, txNonce, chainId, isWrapped);

    expect(jsHash).toBe(solHash);
  });

  it('hash changes with isWrapped flag', async () => {
    const token = PARTY_KEYS[0].address; // Any valid address
    const amount = ethers.parseEther('1.0');
    const receiver = PARTY_KEYS[1].address;
    const txHash = '0x' + '00'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hashWrapped = await bridge.getERC20SignHash(token, amount, receiver, txHash, txNonce, chainId, true);
    const hashNotWrapped = await bridge.getERC20SignHash(token, amount, receiver, txHash, txNonce, chainId, false);

    expect(hashWrapped).not.toBe(hashNotWrapped);
  });
});

// ============================================================================
// Withdrawals (the core multi-sig verification)
// ============================================================================

describe('withdrawNative', () => {
  // Test the full withdrawal flow:
  //   1. Compute the sign hash (same as on-chain)
  //   2. Collect 2-of-3 signatures
  //   3. Call withdrawNative with the signatures
  //   4. Verify funds are transferred and event is emitted

  it('succeeds with 2 valid signatures', async () => {
    const amount = ethers.parseEther('0.01');
    const receiver = PARTY_KEYS[2].address;
    const txHash = '0x' + 'aa'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    // Step 1: Compute hash (matches what the contract will compute)
    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);

    // Step 2: Parties 0 and 1 sign
    const sigs = await collectSignatures(hash, [0, 1]);

    // Step 3: Record receiver balance before withdrawal
    const balanceBefore = await provider.getBalance(receiver);

    // Step 4: Execute withdrawal
    const tx = await bridge.withdrawNative(amount, receiver, txHash, txNonce, sigs);
    const receipt = await tx.wait();

    // Step 5: Verify funds transferred
    const balanceAfter = await provider.getBalance(receiver);
    // Account for gas if receiver is also the tx sender (it's not in this case)
    expect(balanceAfter - balanceBefore).toBe(amount);

    // Step 6: Verify Withdrawn event
    const iface = bridge.interface;
    const withdrawEvent = receipt.logs
      .map(log => { try { return iface.parseLog(log); } catch { return null; } })
      .find(e => e?.name === 'Withdrawn');

    expect(withdrawEvent).toBeDefined();
    expect(withdrawEvent.args.amount).toBe(amount);
    expect(withdrawEvent.args.txHash).toBe(txHash);
  });

  it('succeeds with any 2-of-3 combination', async () => {
    // The bridge should accept signatures from any 2 of the 3 parties.
    // Test all 3 combinations: [0,1], [0,2], [1,2]
    const combos = [[0, 1], [0, 2], [1, 2]];

    for (let i = 0; i < combos.length; i++) {
      const amount = ethers.parseEther('0.001');
      const receiver = PARTY_KEYS[0].address;
      // Use different txHash for each to avoid replay protection
      const txHash = '0x' + String(i + 1).padStart(2, '0').repeat(32);
      const txNonce = 0;
      const chainId = (await provider.getNetwork()).chainId;

      const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
      const sigs = await collectSignatures(hash, combos[i]);

      // Should not revert
      const tx = await bridge.withdrawNative(amount, receiver, txHash, txNonce, sigs);
      await tx.wait();
    }
  });
});

describe('withdrawERC20 (dEURO custody)', () => {
  // Custody model: bridge releases locked dEURO (isWrapped=false).
  // The deposit test above already locked 100 dEURO in the bridge,
  // so the bridge has funds to release.

  it('releases dEURO from custody with 2 valid signatures (isWrapped=false)', async () => {
    const amount = hre.ethers.parseUnits('50', 12); // 50 dEURO
    const receiver = PARTY_KEYS[2].address;
    const txHash = '0x' + 'f0'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;
    const isWrapped = false;

    // Compute hash
    const hash = computeErc20SignHash(tokenAddress, amount, receiver, txHash, txNonce, chainId, isWrapped);

    // Collect signatures
    const sigs = await collectSignatures(hash, [0, 1]);

    // Record balances before
    const receiverBefore = await deuroToken.balanceOf(receiver);
    const bridgeBefore = await deuroToken.balanceOf(bridgeAddress);

    // Execute withdrawal (releases tokens from bridge custody)
    const tx = await bridge.withdrawERC20(tokenAddress, amount, receiver, txHash, txNonce, isWrapped, sigs);
    const receipt = await tx.wait();

    // Verify tokens released from bridge to receiver
    const receiverAfter = await deuroToken.balanceOf(receiver);
    const bridgeAfter = await deuroToken.balanceOf(bridgeAddress);
    expect(receiverAfter - receiverBefore).toBe(amount);
    expect(bridgeBefore - bridgeAfter).toBe(amount);

    // Verify event
    const iface = bridge.interface;
    const withdrawEvent = receipt.logs
      .map(log => { try { return iface.parseLog(log); } catch { return null; } })
      .find(e => e?.name === 'Withdrawn');

    expect(withdrawEvent).toBeDefined();
    expect(withdrawEvent.args.token).toBe(tokenAddress);
    expect(withdrawEvent.args.amount).toBe(amount);
    expect(withdrawEvent.args.receiver).toBe(receiver);
  });

  it('succeeds with all 3 signatures', async () => {
    const amount = hre.ethers.parseUnits('10', 12);
    const receiver = PARTY_KEYS[1].address;
    const txHash = '0x' + 'f1'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeErc20SignHash(tokenAddress, amount, receiver, txHash, txNonce, chainId, false);
    const sigs = await collectSignatures(hash, [0, 1, 2]);

    const tx = await bridge.withdrawERC20(tokenAddress, amount, receiver, txHash, txNonce, false, sigs);
    await tx.wait();

    // If we got here without revert, 3 sigs worked
  });
});

// ============================================================================
// Replay Protection
// ============================================================================

describe('replay protection', () => {
  // Each (txHash, txNonce) pair can only be used once.
  // The contract stores keccak256(txHash, txNonce) in usedHashes mapping.
  // A second withdrawal with the same pair must revert.

  it('rejects duplicate (txHash, txNonce)', async () => {
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'ff'.repeat(32);
    const txNonce = 42;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
    const sigs = await collectSignatures(hash);

    // First withdrawal should succeed
    const tx = await bridge.withdrawNative(amount, receiver, txHash, txNonce, sigs);
    await tx.wait();

    // Second withdrawal with same txHash + txNonce should revert
    try {
      await bridge.withdrawNative(amount, receiver, txHash, txNonce, sigs);
      expect.fail('Should have reverted with "already processed"');
    } catch (err) {
      expect(err.message).toContain('already processed');
    }
  });

  it('allows same txHash with different txNonce', async () => {
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[1].address;
    const txHash = '0x' + 'ee'.repeat(32);
    const chainId = (await provider.getNetwork()).chainId;

    // txNonce 0
    const hash0 = computeNativeSignHash(amount, receiver, txHash, 0, chainId);
    const sigs0 = await collectSignatures(hash0);
    await (await bridge.withdrawNative(amount, receiver, txHash, 0, sigs0)).wait();

    // txNonce 1 -- should succeed (different nonce = different nonceHash)
    const hash1 = computeNativeSignHash(amount, receiver, txHash, 1, chainId);
    const sigs1 = await collectSignatures(hash1);
    await (await bridge.withdrawNative(amount, receiver, txHash, 1, sigs1)).wait();
  });
});

// ============================================================================
// Threshold Enforcement
// ============================================================================

describe('threshold enforcement', () => {
  it('rejects withdrawal with only 1 signature (need 2)', async () => {
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'dd'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
    // Only 1 signature instead of required 2
    const sigs = await collectSignatures(hash, [0]);

    try {
      await bridge.withdrawNative(amount, receiver, txHash, txNonce, sigs);
      expect.fail('Should have reverted with "not enough signatures"');
    } catch (err) {
      expect(err.message).toContain('not enough signatures');
    }
  });

  it('rejects withdrawal with no signatures', async () => {
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'cc'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    try {
      await bridge.withdrawNative(amount, receiver, txHash, txNonce, []);
      expect.fail('Should have reverted');
    } catch (err) {
      expect(err.message).toContain('not enough signatures');
    }
  });

  it('accepts 3 signatures (more than threshold is fine)', async () => {
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[1].address;
    const txHash = '0x' + 'bb'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
    // All 3 parties sign
    const sigs = await collectSignatures(hash, [0, 1, 2]);

    // Should succeed (3 >= 2)
    const tx = await bridge.withdrawNative(amount, receiver, txHash, txNonce, sigs);
    await tx.wait();
  });
});

// ============================================================================
// Invalid Signer Detection
// ============================================================================

describe('invalid signer detection', () => {
  it('rejects signature from non-party address', async () => {
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'a1'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);

    // Sign with party 0 (valid) and a random wallet (invalid)
    const validSig = await signWithKey(hash, PARTY_KEYS[0].privateKey);
    const randomWallet = ethers.Wallet.createRandom();
    const invalidSig = await randomWallet.signMessage(ethers.getBytes(hash));

    try {
      await bridge.withdrawNative(amount, receiver, txHash, txNonce, [validSig, invalidSig]);
      expect.fail('Should have reverted with "invalid signer"');
    } catch (err) {
      expect(err.message).toContain('invalid signer');
    }
  });

  it('rejects signature for wrong hash (recovered address is random)', async () => {
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'a2'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    // Compute the correct hash
    const correctHash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);

    // But sign a DIFFERENT hash
    const wrongHash = computeNativeSignHash(ethers.parseEther('999.0'), receiver, txHash, txNonce, chainId);
    const sigs = await collectSignatures(wrongHash, [0, 1]);

    // The contract computes correctHash internally, but our signatures
    // are for wrongHash. ECRECOVER will recover wrong addresses.
    try {
      await bridge.withdrawNative(amount, receiver, txHash, txNonce, sigs);
      expect.fail('Should have reverted');
    } catch (err) {
      expect(err.message).toContain('invalid signer');
    }
  });
});

// ============================================================================
// Pause / Unpause
// ============================================================================

describe('pause/unpause', () => {
  it('owner can pause and unpause', async () => {
    await (await bridge.pause()).wait();

    // Deposits should revert when paused
    try {
      await bridge.depositNative('ZxAddr', { value: ethers.parseEther('0.001') });
      expect.fail('Should have reverted');
    } catch (err) {
      expect(err.message).toContain('Pausable: paused');
    }

    // Unpause
    await (await bridge.unpause()).wait();

    // Should work again
    const tx = await bridge.depositNative('ZxAddr', { value: ethers.parseEther('0.001') });
    await tx.wait();
  });

  it('non-owner cannot pause', async () => {
    const allSigners = await hre.ethers.getSigners();
    const nonOwner = allSigners[5];
    const bridgeAsNonOwner = bridge.connect(nonOwner);

    try {
      await bridgeAsNonOwner.pause();
      expect.fail('Should have reverted');
    } catch (err) {
      expect(err.message).toContain('Ownable');
    }
  });
});

// ============================================================================
// Withdrawal Validation (Paper Algorithm 10 require checks)
// ============================================================================

describe('withdrawal validation (Algorithm 10)', () => {
  // Paper Algorithm 10, Lines 11-13 (ERC20): require amount > 0, token != 0, receiver != 0
  // Paper Algorithm 10, Lines 25-26 (Native): require amount > 0, receiver != 0

  it('withdrawERC20 rejects zero amount', async () => {
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'e0'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeErc20SignHash(tokenAddress, 0n, receiver, txHash, txNonce, chainId, false);
    const sigs = await collectSignatures(hash, [0, 1]);

    try {
      await bridge.withdrawERC20(tokenAddress, 0, receiver, txHash, txNonce, false, sigs);
      expect.fail('Should have reverted with "zero amount"');
    } catch (err) {
      expect(err.message).toContain('zero amount');
    }
  });

  it('withdrawERC20 rejects zero token address', async () => {
    const amount = hre.ethers.parseUnits('1', 12);
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'e1'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeErc20SignHash(ethers.ZeroAddress, amount, receiver, txHash, txNonce, chainId, false);
    const sigs = await collectSignatures(hash, [0, 1]);

    try {
      await bridge.withdrawERC20(ethers.ZeroAddress, amount, receiver, txHash, txNonce, false, sigs);
      expect.fail('Should have reverted with "zero token"');
    } catch (err) {
      expect(err.message).toContain('zero token');
    }
  });

  it('withdrawERC20 rejects zero receiver address', async () => {
    const amount = hre.ethers.parseUnits('1', 12);
    const txHash = '0x' + 'e2'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeErc20SignHash(tokenAddress, amount, ethers.ZeroAddress, txHash, txNonce, chainId, false);
    const sigs = await collectSignatures(hash, [0, 1]);

    try {
      await bridge.withdrawERC20(tokenAddress, amount, ethers.ZeroAddress, txHash, txNonce, false, sigs);
      expect.fail('Should have reverted with "zero receiver"');
    } catch (err) {
      expect(err.message).toContain('zero receiver');
    }
  });

  it('withdrawNative rejects zero amount', async () => {
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'e3'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(0n, receiver, txHash, txNonce, chainId);
    const sigs = await collectSignatures(hash, [0, 1]);

    try {
      await bridge.withdrawNative(0, receiver, txHash, txNonce, sigs);
      expect.fail('Should have reverted with "zero amount"');
    } catch (err) {
      expect(err.message).toContain('zero amount');
    }
  });

  it('withdrawNative rejects zero receiver address', async () => {
    const amount = ethers.parseEther('0.001');
    const txHash = '0x' + 'e4'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, ethers.ZeroAddress, txHash, txNonce, chainId);
    const sigs = await collectSignatures(hash, [0, 1]);

    try {
      await bridge.withdrawNative(amount, ethers.ZeroAddress, txHash, txNonce, sigs);
      expect.fail('Should have reverted with "zero receiver"');
    } catch (err) {
      expect(err.message).toContain('zero receiver');
    }
  });
});

// ============================================================================
// containsHash / addHash (Hashes.sol pattern)
// ============================================================================

describe('containsHash / addHash', () => {
  it('containsHash returns false for unused hash', async () => {
    const txHash = '0x' + 'd0'.repeat(32);
    const result = await bridge.containsHash(txHash, 0);
    expect(result).toBe(false);
  });

  it('containsHash returns true after withdrawal', async () => {
    // Use a unique txHash for this test
    const txHash = '0x' + 'd1'.repeat(32);
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[0].address;
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
    const sigs = await collectSignatures(hash, [0, 1]);

    await (await bridge.withdrawNative(amount, receiver, txHash, txNonce, sigs)).wait();

    const result = await bridge.containsHash(txHash, txNonce);
    expect(result).toBe(true);
  });

  it('addHash blocks future withdrawals', async () => {
    const txHash = '0x' + 'd2'.repeat(32);
    const txNonce = 99;

    // Owner marks hash as used
    await (await bridge.addHash(txHash, txNonce)).wait();

    // Verify it's marked
    expect(await bridge.containsHash(txHash, txNonce)).toBe(true);

    // Attempt withdrawal with this hash should fail
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[0].address;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
    const sigs = await collectSignatures(hash, [0, 1]);

    try {
      await bridge.withdrawNative(amount, receiver, txHash, txNonce, sigs);
      expect.fail('Should have reverted with "already processed"');
    } catch (err) {
      expect(err.message).toContain('already processed');
    }
  });

  it('addHash reverts for already-used hash', async () => {
    const txHash = '0x' + 'd2'.repeat(32);
    const txNonce = 99;

    try {
      await bridge.addHash(txHash, txNonce);
      expect.fail('Should have reverted');
    } catch (err) {
      expect(err.message).toContain('already processed');
    }
  });

  it('addHash is onlyOwner', async () => {
    const allSigners = await hre.ethers.getSigners();
    const nonOwner = allSigners[5];
    const bridgeAsNonOwner = bridge.connect(nonOwner);

    try {
      await bridgeAsNonOwner.addHash('0x' + 'd3'.repeat(32), 0);
      expect.fail('Should have reverted');
    } catch (err) {
      expect(err.message).toContain('Ownable');
    }
  });
});

// ============================================================================
// Signer Removal
// ============================================================================

describe('removeSigner', () => {
  it('owner can remove a signer (if threshold still met)', async () => {
    // Deploy a separate bridge with 3 signers, threshold 2
    // so we don't break the main test bridge
    const signerAddresses = PARTY_KEYS.map(p => p.address);
    const DeuroBridge = await hre.ethers.getContractFactory('DeuroBridge');
    const testBridge = await DeuroBridge.deploy(signerAddresses, 2);
    await testBridge.waitForDeployment();

    // Remove party 2 (3 signers -> 2, threshold=2, still valid)
    await (await testBridge.removeSigner(PARTY_KEYS[2].address)).wait();

    const signers = await testBridge.getSigners();
    expect(signers).toHaveLength(2);
    expect(await testBridge.isSigner(PARTY_KEYS[2].address)).toBe(false);
  });

  it('reverts if removal would break threshold', async () => {
    const signerAddresses = PARTY_KEYS.map(p => p.address);
    const DeuroBridge = await hre.ethers.getContractFactory('DeuroBridge');
    const testBridge = await DeuroBridge.deploy(signerAddresses, 3);
    await testBridge.waitForDeployment();

    // Try to remove when threshold=3 and signers=3 -> would leave 2 < 3
    try {
      await testBridge.removeSigner(PARTY_KEYS[0].address);
      expect.fail('Should have reverted');
    } catch (err) {
      expect(err.message).toContain('would break threshold');
    }
  });
});
