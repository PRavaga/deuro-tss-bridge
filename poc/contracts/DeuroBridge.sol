// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Simplified bridge contract for deuro TSS Bridge PoC.
// Based on Bridgeless bridge-contracts/contracts/bridge/Bridge.sol
//
// Key differences from Bridgeless:
// - No proxy/upgradeable pattern (simpler for PoC)
// - No ERC721/ERC1155 handlers (only ERC20 and native)
// - Same signature verification logic (Signers.sol pattern)
// - Same hash computation (must match off-chain signing)
// - Same replay protection (Hashes.sol pattern)

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

interface IERC20Mintable is IERC20 {
    function mint(address to, uint256 amount) external;
    function burnFrom(address from, uint256 amount) external;
}

contract DeuroBridge is Ownable, ReentrancyGuard, Pausable {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    // --- State ---

    uint256 public signaturesThreshold;
    address[] public signers;
    mapping(address => bool) public isSigner;
    mapping(bytes32 => bool) public usedHashes;

    // --- Events ---
    // Match Bridgeless event signatures for compatibility

    event DepositedERC20(
        address indexed token,
        uint256 amount,
        string receiver,
        string network,
        bool isWrapped,
        uint16 referralId
    );

    event DepositedNative(
        uint256 amount,
        string receiver,
        string network,
        uint16 referralId
    );

    event Withdrawn(
        address indexed token,
        uint256 amount,
        address indexed receiver,
        bytes32 txHash,
        uint256 txNonce
    );

    // --- Constructor ---

    constructor(address[] memory signers_, uint256 threshold_) {
        require(threshold_ > 0, "zero threshold");
        require(signers_.length >= threshold_, "not enough signers");

        for (uint256 i = 0; i < signers_.length; i++) {
            require(signers_[i] != address(0), "zero signer");
            require(!isSigner[signers_[i]], "duplicate signer");
            isSigner[signers_[i]] = true;
        }
        signers = signers_;
        signaturesThreshold = threshold_;
    }

    // --- Deposit functions (lock/burn tokens on EVM side) ---

    /**
     * @notice Deposit ERC20 tokens to bridge them to Zano.
     * @param token_ Token address
     * @param amount_ Amount to bridge
     * @param receiver_ Zano address (string)
     * @param isWrapped_ If true, tokens are burned. If false, tokens are locked.
     *
     * Bridgeless ref: bridge-contracts/contracts/handlers/ERC20Handler.sol depositERC20()
     */
    function depositERC20(
        address token_,
        uint256 amount_,
        string calldata receiver_,
        bool isWrapped_
    ) external whenNotPaused {
        require(token_ != address(0), "zero token");
        require(amount_ > 0, "zero amount");

        if (isWrapped_) {
            IERC20Mintable(token_).burnFrom(msg.sender, amount_);
        } else {
            IERC20(token_).safeTransferFrom(msg.sender, address(this), amount_);
        }

        emit DepositedERC20(token_, amount_, receiver_, "zano", isWrapped_, 0);
    }

    /**
     * @notice Deposit native ETH to bridge to Zano.
     * @param receiver_ Zano address (string)
     *
     * Bridgeless ref: bridge-contracts/contracts/handlers/NativeHandler.sol depositNative()
     */
    function depositNative(string calldata receiver_) external payable whenNotPaused {
        require(msg.value > 0, "zero value");
        emit DepositedNative(msg.value, receiver_, "zano", 0);
    }

    // --- Withdrawal functions (release/mint tokens on EVM side) ---

    /**
     * @notice Withdraw ERC20 tokens after bridging from Zano.
     * Requires threshold signatures from the TSS group.
     *
     * Bridgeless ref: bridge-contracts/contracts/bridge/Bridge.sol withdrawERC20()
     */
    function withdrawERC20(
        address token_,
        uint256 amount_,
        address receiver_,
        bytes32 txHash_,
        uint256 txNonce_,
        bool isWrapped_,
        bytes[] calldata signatures_
    ) external whenNotPaused nonReentrant {
        bytes32 signHash_ = getERC20SignHash(
            token_, amount_, receiver_, txHash_, txNonce_, block.chainid, isWrapped_
        );

        _checkAndUpdateHashes(txHash_, txNonce_);
        _checkSignatures(signHash_, signatures_);

        // Paper Algorithm 10, Lines 11-13: validation checks
        // Production ref: bridge-contracts/contracts/handlers/ERC20Handler.sol _withdrawERC20()
        require(amount_ > 0, "zero amount");
        require(token_ != address(0), "zero token");
        require(receiver_ != address(0), "zero receiver");

        if (isWrapped_) {
            IERC20Mintable(token_).mint(receiver_, amount_);
        } else {
            IERC20(token_).safeTransfer(receiver_, amount_);
        }

        emit Withdrawn(token_, amount_, receiver_, txHash_, txNonce_);
    }

    /**
     * @notice Withdraw native ETH after bridging from Zano.
     *
     * Bridgeless ref: bridge-contracts/contracts/bridge/Bridge.sol withdrawNative()
     */
    function withdrawNative(
        uint256 amount_,
        address receiver_,
        bytes32 txHash_,
        uint256 txNonce_,
        bytes[] calldata signatures_
    ) external whenNotPaused nonReentrant {
        bytes32 signHash_ = getNativeSignHash(
            amount_, receiver_, txHash_, txNonce_, block.chainid
        );

        _checkAndUpdateHashes(txHash_, txNonce_);
        _checkSignatures(signHash_, signatures_);

        // Paper Algorithm 10, Lines 25-26: validation checks
        // Production ref: bridge-contracts/contracts/handlers/NativeHandler.sol _withdrawNative()
        require(amount_ > 0, "zero amount");
        require(receiver_ != address(0), "zero receiver");

        (bool sent,) = payable(receiver_).call{value: amount_}("");
        require(sent, "ETH transfer failed");

        emit Withdrawn(address(0), amount_, receiver_, txHash_, txNonce_);
    }

    // --- Hash computation (must match off-chain) ---

    /**
     * Bridgeless ref: bridge-contracts/contracts/handlers/ERC20Handler.sol getERC20SignHash()
     */
    function getERC20SignHash(
        address token_,
        uint256 amount_,
        address receiver_,
        bytes32 txHash_,
        uint256 txNonce_,
        uint256 chainId_,
        bool isWrapped_
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(
            token_, amount_, receiver_, txHash_, txNonce_, chainId_, isWrapped_
        ));
    }

    /**
     * Bridgeless ref: bridge-contracts/contracts/handlers/NativeHandler.sol getNativeSignHash()
     */
    function getNativeSignHash(
        uint256 amount_,
        address receiver_,
        bytes32 txHash_,
        uint256 txNonce_,
        uint256 chainId_
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(
            amount_, receiver_, txHash_, txNonce_, chainId_
        ));
    }

    // --- Signature verification ---

    /**
     * Verify that enough valid signatures are provided.
     *
     * Bridgeless ref: bridge-contracts/contracts/utils/Signers.sol _checkSignatures()
     */
    function _checkSignatures(bytes32 signHash_, bytes[] calldata signatures_) internal view {
        require(signatures_.length >= signaturesThreshold, "not enough signatures");

        uint256 bitMap;
        for (uint256 i = 0; i < signatures_.length; i++) {
            address recovered = signHash_.toEthSignedMessageHash().recover(signatures_[i]);
            require(isSigner[recovered], "invalid signer");

            // Duplicate check using bitmap (Bridgeless Signers.sol pattern)
            uint256 bitKey = 2 ** (uint256(uint160(recovered)) >> 152);
            require(bitMap & bitKey == 0, "duplicate signer");
            bitMap |= bitKey;
        }
    }

    // --- Replay protection ---

    /**
     * Bridgeless ref: bridge-contracts/contracts/utils/Hashes.sol _checkAndUpdateHashes()
     */
    function _checkAndUpdateHashes(bytes32 txHash_, uint256 txNonce_) internal {
        bytes32 nonceHash_ = keccak256(abi.encodePacked(txHash_, txNonce_));
        require(!usedHashes[nonceHash_], "already processed");
        usedHashes[nonceHash_] = true;
    }

    // --- Hash query / admin ---

    /**
     * Check if a (txHash, txNonce) pair has already been processed.
     *
     * Bridgeless ref: bridge-contracts/contracts/utils/Hashes.sol containsHash()
     */
    function containsHash(bytes32 txHash_, uint256 txNonce_) external view returns (bool) {
        bytes32 nonceHash_ = keccak256(abi.encodePacked(txHash_, txNonce_));
        return usedHashes[nonceHash_];
    }

    /**
     * Mark a (txHash, txNonce) pair as used without executing a withdrawal.
     * Emergency measure to block specific deposit hashes.
     *
     * Bridgeless ref: bridge-contracts/contracts/bridge/Bridge.sol addHash()
     */
    function addHash(bytes32 txHash_, uint256 txNonce_) external onlyOwner {
        bytes32 nonceHash_ = keccak256(abi.encodePacked(txHash_, txNonce_));
        require(!usedHashes[nonceHash_], "already processed");
        usedHashes[nonceHash_] = true;
    }

    // --- Admin functions ---

    function addSigner(address signer_) external onlyOwner {
        require(signer_ != address(0), "zero signer");
        require(!isSigner[signer_], "already signer");
        isSigner[signer_] = true;
        signers.push(signer_);
    }

    function removeSigner(address signer_) external onlyOwner {
        require(isSigner[signer_], "not a signer");
        isSigner[signer_] = false;

        // Remove from array
        for (uint256 i = 0; i < signers.length; i++) {
            if (signers[i] == signer_) {
                signers[i] = signers[signers.length - 1];
                signers.pop();
                break;
            }
        }

        require(signers.length >= signaturesThreshold, "would break threshold");
    }

    function setThreshold(uint256 threshold_) external onlyOwner {
        require(threshold_ > 0 && threshold_ <= signers.length, "invalid threshold");
        signaturesThreshold = threshold_;
    }

    function getSigners() external view returns (address[] memory) {
        return signers;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // Allow contract to receive ETH
    receive() external payable {}
}
