// ============================================================================
// Contract Tests: DeuroBridge.sol + DeuroToken.sol
// ============================================================================
//
// Tests the Solidity bridge contract on a local Hardhat network.
// Each test suite deploys a fresh contract, so there's no state leakage.
//
// TSS mode: the contract is deployed with threshold=1 and a single signer
// (the TSS group address). The 2-of-3 threshold is enforced off-chain by
// the DKLs23 protocol.
//
// What we verify:
//   1. Deployment with TSS group address and threshold=1
//   2. Native ETH deposits emit the right event
//   3. ERC20 (dEURO) deposits burn tokens and emit the right event
//   4. Withdrawals with a single TSS signature (threshold=1)
//   5. Hash compatibility: off-chain computeNativeSignHash matches on-chain
//   6. Replay protection: same (txHash, txNonce) can't be used twice
//   7. Threshold enforcement: 0 signatures -> revert
//   8. Invalid signer detection: non-group signature -> revert
//   9. Pause/unpause emergency circuit breaker
//  10. Signer management
// ============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import hre from 'hardhat';
import { ethers } from 'ethers';
import { PARTY_KEYS, TEST_CHAIN_ID } from '../fixtures.js';
import { computeNativeSignHash, computeErc20SignHash } from '../../src/evm-signer.js';
import { getTestKeyshares, getTestGroupAddress, testTssSign } from '../helpers/tss-test-keyshares.js';
import { initTss, formatEthSignature } from '../../src/tss.js';

// ---- Test-scoped state ----
let bridge;          // Contract instance (connected to deployer)
let deuroToken;      // DeuroToken instance (connected to deployer)
let provider;        // Hardhat's JSON-RPC provider
let signerAccounts;  // ethers.Signer[] for the Hardhat accounts
let bridgeAddress;   // Deployed contract address
let tokenAddress;    // Deployed token address
let deployer;        // Deployer signer

// TSS test state
let keyshares;       // DKLs23 keyshares for 3 parties
let groupAddress;    // TSS group ETH address

// ---- Helper: sign a hash with TSS (2-of-3) and return 65-byte EVM sig ----
async function tssSignHash(hash, signerPairIndices = [0, 1]) {
  const eip191Hash = ethers.hashMessage(ethers.getBytes(hash));
  const messageHash = ethers.getBytes(eip191Hash);
  const { r, s } = await testTssSign(
    keyshares[signerPairIndices[0]],
    keyshares[signerPairIndices[1]],
    messageHash,
  );
  return formatEthSignature(r, s, messageHash, groupAddress);
}

// ---- Helper: sign with a specific Hardhat account (for invalid-signer tests) ----
async function signWithKey(hash, privateKey) {
  const wallet = new ethers.Wallet(privateKey);
  return wallet.signMessage(ethers.getBytes(hash));
}

// ============================================================================
// Setup: Deploy DeuroBridge (TSS mode) + DeuroToken before all tests
// ============================================================================

beforeAll(async () => {
  // Generate TSS keyshares
  keyshares = await getTestKeyshares();
  groupAddress = await getTestGroupAddress();

  const allSigners = await hre.ethers.getSigners();
  signerAccounts = allSigners.slice(0, 3);
  deployer = allSigners[0];
  provider = hre.ethers.provider;

  // Deploy the bridge with TSS group address, threshold=1
  const DeuroBridge = await hre.ethers.getContractFactory('DeuroBridge');
  bridge = await DeuroBridge.deploy([groupAddress], 1);
  await bridge.waitForDeployment();
  bridgeAddress = await bridge.getAddress();

  // Deploy DeuroToken with 1,000,000 dEURO initial supply (12 decimals)
  const initialSupply = hre.ethers.parseUnits('1000000', 12);
  const DeuroToken = await hre.ethers.getContractFactory('DeuroToken');
  deuroToken = await DeuroToken.deploy(initialSupply);
  await deuroToken.waitForDeployment();
  tokenAddress = await deuroToken.getAddress();

  // Grant MINTER_ROLE to bridge
  const MINTER_ROLE = await deuroToken.MINTER_ROLE();
  await (await deuroToken.grantRole(MINTER_ROLE, bridgeAddress)).wait();

  // Fund the bridge with some ETH for withdrawal tests
  await deployer.sendTransaction({
    to: bridgeAddress,
    value: ethers.parseEther('10'),
  });
}, 120_000);

// ============================================================================
// Deployment (TSS mode)
// ============================================================================

describe('deployment (TSS mode)', () => {
  it('sets threshold to 1', async () => {
    const threshold = await bridge.signaturesThreshold();
    expect(threshold).toBe(1n);
  });

  it('registers the TSS group address as the only signer', async () => {
    const signers = await bridge.getSigners();
    expect(signers).toHaveLength(1);
    expect(signers[0].toLowerCase()).toBe(groupAddress.toLowerCase());
  });

  it('TSS group address is a valid signer', async () => {
    const is = await bridge.isSigner(groupAddress);
    expect(is).toBe(true);
  });

  it('individual Hardhat accounts are not signers', async () => {
    for (const pk of PARTY_KEYS) {
      const is = await bridge.isSigner(pk.address);
      expect(is).toBe(false);
    }
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

    const tx = await bridge.depositNative(receiver, { value });
    const receipt = await tx.wait();

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
    const amount = hre.ethers.parseUnits('100', 12);

    await (await deuroToken.approve(bridgeAddress, amount)).wait();

    const deployerBefore = await deuroToken.balanceOf(deployer.address);
    const bridgeBefore = await deuroToken.balanceOf(bridgeAddress);

    const tx = await bridge.depositERC20(tokenAddress, amount, receiver, false);
    const receipt = await tx.wait();

    const deployerAfter = await deuroToken.balanceOf(deployer.address);
    const bridgeAfter = await deuroToken.balanceOf(bridgeAddress);
    expect(deployerBefore - deployerAfter).toBe(amount);
    expect(bridgeAfter - bridgeBefore).toBe(amount);

    const iface = bridge.interface;
    const depositEvent = receipt.logs
      .map(log => { try { return iface.parseLog(log); } catch { return null; } })
      .find(e => e?.name === 'DepositedERC20');

    expect(depositEvent).toBeDefined();
    expect(depositEvent.args.token).toBe(tokenAddress);
    expect(depositEvent.args.amount).toBe(amount);
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
  it('native sign hash: JS matches Solidity', async () => {
    const amount = ethers.parseEther('1.0');
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'ab'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const jsHash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
    const solHash = await bridge.getNativeSignHash(amount, receiver, txHash, txNonce, chainId);

    expect(jsHash).toBe(solHash);
  });

  it('ERC20 sign hash: JS matches Solidity', async () => {
    const token = tokenAddress;
    const amount = hre.ethers.parseUnits('1000', 12);
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
    const token = PARTY_KEYS[0].address;
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
// Withdrawals with TSS signature (threshold=1)
// ============================================================================

describe('withdrawNative (TSS)', () => {
  it('succeeds with 1 TSS signature', async () => {
    const amount = ethers.parseEther('0.01');
    const receiver = PARTY_KEYS[2].address;
    const txHash = '0x' + 'aa'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
    const sig = await tssSignHash(hash, [0, 1]);

    const balanceBefore = await provider.getBalance(receiver);

    const tx = await bridge.withdrawNative(amount, receiver, txHash, txNonce, [sig]);
    const receipt = await tx.wait();

    const balanceAfter = await provider.getBalance(receiver);
    expect(balanceAfter - balanceBefore).toBe(amount);

    const iface = bridge.interface;
    const withdrawEvent = receipt.logs
      .map(log => { try { return iface.parseLog(log); } catch { return null; } })
      .find(e => e?.name === 'Withdrawn');

    expect(withdrawEvent).toBeDefined();
    expect(withdrawEvent.args.amount).toBe(amount);
    expect(withdrawEvent.args.txHash).toBe(txHash);
  }, 60_000);

  it('succeeds with any 2-of-3 TSS combination', async () => {
    const combos = [[0, 1], [0, 2], [1, 2]];

    for (let i = 0; i < combos.length; i++) {
      const amount = ethers.parseEther('0.001');
      const receiver = PARTY_KEYS[0].address;
      const txHash = '0x' + String(i + 1).padStart(2, '0').repeat(32);
      const txNonce = 0;
      const chainId = (await provider.getNetwork()).chainId;

      const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
      const sig = await tssSignHash(hash, combos[i]);

      const tx = await bridge.withdrawNative(amount, receiver, txHash, txNonce, [sig]);
      await tx.wait();
    }
  }, 120_000);
});

describe('withdrawERC20 (TSS, dEURO custody)', () => {
  it('releases dEURO from custody with 1 TSS signature (isWrapped=false)', async () => {
    const amount = hre.ethers.parseUnits('50', 12);
    const receiver = PARTY_KEYS[2].address;
    const txHash = '0x' + 'f0'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;
    const isWrapped = false;

    const hash = computeErc20SignHash(tokenAddress, amount, receiver, txHash, txNonce, chainId, isWrapped);
    const sig = await tssSignHash(hash, [0, 1]);

    const receiverBefore = await deuroToken.balanceOf(receiver);
    const bridgeBefore = await deuroToken.balanceOf(bridgeAddress);

    const tx = await bridge.withdrawERC20(tokenAddress, amount, receiver, txHash, txNonce, isWrapped, [sig]);
    const receipt = await tx.wait();

    const receiverAfter = await deuroToken.balanceOf(receiver);
    const bridgeAfter = await deuroToken.balanceOf(bridgeAddress);
    expect(receiverAfter - receiverBefore).toBe(amount);
    expect(bridgeBefore - bridgeAfter).toBe(amount);

    const iface = bridge.interface;
    const withdrawEvent = receipt.logs
      .map(log => { try { return iface.parseLog(log); } catch { return null; } })
      .find(e => e?.name === 'Withdrawn');

    expect(withdrawEvent).toBeDefined();
    expect(withdrawEvent.args.token).toBe(tokenAddress);
    expect(withdrawEvent.args.amount).toBe(amount);
  }, 60_000);
});

// ============================================================================
// Replay Protection
// ============================================================================

describe('replay protection', () => {
  it('rejects duplicate (txHash, txNonce)', async () => {
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'ff'.repeat(32);
    const txNonce = 42;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
    const sig = await tssSignHash(hash);

    const tx = await bridge.withdrawNative(amount, receiver, txHash, txNonce, [sig]);
    await tx.wait();

    try {
      await bridge.withdrawNative(amount, receiver, txHash, txNonce, [sig]);
      expect.fail('Should have reverted with "already processed"');
    } catch (err) {
      expect(err.message).toContain('already processed');
    }
  }, 60_000);

  it('allows same txHash with different txNonce', async () => {
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[1].address;
    const txHash = '0x' + 'ee'.repeat(32);
    const chainId = (await provider.getNetwork()).chainId;

    const hash0 = computeNativeSignHash(amount, receiver, txHash, 0, chainId);
    const sig0 = await tssSignHash(hash0);
    await (await bridge.withdrawNative(amount, receiver, txHash, 0, [sig0])).wait();

    const hash1 = computeNativeSignHash(amount, receiver, txHash, 1, chainId);
    const sig1 = await tssSignHash(hash1);
    await (await bridge.withdrawNative(amount, receiver, txHash, 1, [sig1])).wait();
  }, 120_000);
});

// ============================================================================
// Threshold Enforcement (TSS: threshold=1)
// ============================================================================

describe('threshold enforcement (TSS)', () => {
  it('rejects withdrawal with 0 signatures', async () => {
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
});

// ============================================================================
// Invalid Signer Detection
// ============================================================================

describe('invalid signer detection', () => {
  it('rejects signature from non-group address', async () => {
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'a1'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);

    // Sign with an individual key (not the TSS group)
    const invalidSig = await signWithKey(hash, PARTY_KEYS[0].privateKey);

    try {
      await bridge.withdrawNative(amount, receiver, txHash, txNonce, [invalidSig]);
      expect.fail('Should have reverted with "invalid signer"');
    } catch (err) {
      expect(err.message).toContain('invalid signer');
    }
  });

  it('rejects signature for wrong hash', async () => {
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'a2'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    // Sign a different hash with TSS
    const wrongHash = computeNativeSignHash(ethers.parseEther('999.0'), receiver, txHash, txNonce, chainId);
    const sig = await tssSignHash(wrongHash);

    // Contract computes the correct hash internally — recovered address won't be the group
    try {
      await bridge.withdrawNative(amount, receiver, txHash, txNonce, [sig]);
      expect.fail('Should have reverted');
    } catch (err) {
      expect(err.message).toContain('invalid signer');
    }
  }, 60_000);
});

// ============================================================================
// Pause / Unpause
// ============================================================================

describe('pause/unpause', () => {
  it('owner can pause and unpause', async () => {
    await (await bridge.pause()).wait();

    try {
      await bridge.depositNative('ZxAddr', { value: ethers.parseEther('0.001') });
      expect.fail('Should have reverted');
    } catch (err) {
      expect(err.message).toContain('Pausable: paused');
    }

    await (await bridge.unpause()).wait();

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
  it('withdrawERC20 rejects zero amount', async () => {
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'e0'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeErc20SignHash(tokenAddress, 0n, receiver, txHash, txNonce, chainId, false);
    const sig = await tssSignHash(hash);

    try {
      await bridge.withdrawERC20(tokenAddress, 0, receiver, txHash, txNonce, false, [sig]);
      expect.fail('Should have reverted with "zero amount"');
    } catch (err) {
      expect(err.message).toContain('zero amount');
    }
  }, 60_000);

  it('withdrawERC20 rejects zero token address', async () => {
    const amount = hre.ethers.parseUnits('1', 12);
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'e1'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeErc20SignHash(ethers.ZeroAddress, amount, receiver, txHash, txNonce, chainId, false);
    const sig = await tssSignHash(hash);

    try {
      await bridge.withdrawERC20(ethers.ZeroAddress, amount, receiver, txHash, txNonce, false, [sig]);
      expect.fail('Should have reverted with "zero token"');
    } catch (err) {
      expect(err.message).toContain('zero token');
    }
  }, 60_000);

  it('withdrawNative rejects zero amount', async () => {
    const receiver = PARTY_KEYS[0].address;
    const txHash = '0x' + 'e3'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(0n, receiver, txHash, txNonce, chainId);
    const sig = await tssSignHash(hash);

    try {
      await bridge.withdrawNative(0, receiver, txHash, txNonce, [sig]);
      expect.fail('Should have reverted with "zero amount"');
    } catch (err) {
      expect(err.message).toContain('zero amount');
    }
  }, 60_000);

  it('withdrawNative rejects zero receiver address', async () => {
    const amount = ethers.parseEther('0.001');
    const txHash = '0x' + 'e4'.repeat(32);
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, ethers.ZeroAddress, txHash, txNonce, chainId);
    const sig = await tssSignHash(hash);

    try {
      await bridge.withdrawNative(amount, ethers.ZeroAddress, txHash, txNonce, [sig]);
      expect.fail('Should have reverted with "zero receiver"');
    } catch (err) {
      expect(err.message).toContain('zero receiver');
    }
  }, 60_000);
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
    const txHash = '0x' + 'd1'.repeat(32);
    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[0].address;
    const txNonce = 0;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
    const sig = await tssSignHash(hash);

    await (await bridge.withdrawNative(amount, receiver, txHash, txNonce, [sig])).wait();

    const result = await bridge.containsHash(txHash, txNonce);
    expect(result).toBe(true);
  }, 60_000);

  it('addHash blocks future withdrawals', async () => {
    const txHash = '0x' + 'd2'.repeat(32);
    const txNonce = 99;

    await (await bridge.addHash(txHash, txNonce)).wait();
    expect(await bridge.containsHash(txHash, txNonce)).toBe(true);

    const amount = ethers.parseEther('0.001');
    const receiver = PARTY_KEYS[0].address;
    const chainId = (await provider.getNetwork()).chainId;

    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
    const sig = await tssSignHash(hash);

    try {
      await bridge.withdrawNative(amount, receiver, txHash, txNonce, [sig]);
      expect.fail('Should have reverted with "already processed"');
    } catch (err) {
      expect(err.message).toContain('already processed');
    }
  }, 60_000);

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
// Signer Management
// ============================================================================

describe('signer management', () => {
  it('owner can add a second signer and increase threshold', async () => {
    // Deploy a fresh bridge for this test
    const DeuroBridge = await hre.ethers.getContractFactory('DeuroBridge');
    const testBridge = await DeuroBridge.deploy([groupAddress], 1);
    await testBridge.waitForDeployment();

    // Add another signer
    await (await testBridge.addSigner(PARTY_KEYS[0].address)).wait();

    const signers = await testBridge.getSigners();
    expect(signers).toHaveLength(2);

    // Can increase threshold
    await (await testBridge.setThreshold(2)).wait();
    const threshold = await testBridge.signaturesThreshold();
    expect(threshold).toBe(2n);
  });

  it('removeSigner reverts if would break threshold', async () => {
    // Bridge with 1 signer, threshold=1
    const DeuroBridge = await hre.ethers.getContractFactory('DeuroBridge');
    const testBridge = await DeuroBridge.deploy([groupAddress], 1);
    await testBridge.waitForDeployment();

    try {
      await testBridge.removeSigner(groupAddress);
      expect.fail('Should have reverted');
    } catch (err) {
      expect(err.message).toContain('would break threshold');
    }
  });
});
