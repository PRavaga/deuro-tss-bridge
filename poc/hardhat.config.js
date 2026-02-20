import "@nomicfoundation/hardhat-ethers";

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? '0x' + '0'.repeat(64);

export default {
  solidity: "0.8.19",
  networks: {
    sepolia: {
      url: process.env.EVM_RPC ?? "https://rpc.sepolia.org",
      accounts: [DEPLOYER_KEY],
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
  },
};
