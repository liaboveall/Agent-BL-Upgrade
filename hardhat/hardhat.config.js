import path from 'node:path';
import dotenv from 'dotenv';
import { configVariable, defineConfig } from 'hardhat/config';
import hardhatEthers from '@nomicfoundation/hardhat-ethers';
import hardhatEthersChaiMatchers from '@nomicfoundation/hardhat-ethers-chai-matchers';
import hardhatMocha from '@nomicfoundation/hardhat-mocha';

// Secrets live in the project-root .env; configVariable() reads them from process.env.
if (!process.env.NODE_TEST_CONTEXT && process.env.AGENTBL_W2_INTEGRATION !== '1') dotenv.config({ path: path.join(import.meta.dirname, '..', '.env'), quiet: true });

export default defineConfig({
  plugins: [hardhatEthers, hardhatEthersChaiMatchers, hardhatMocha],
  solidity: {
    version: '0.8.24',
    settings: {
      // Pinned to match the Hardhat 2 build of the contracts deployed on Injective testnet.
      evmVersion: 'paris',
      optimizer: {
        enabled: true,
        runs: 200
      },
      viaIR: true
    }
  },
  paths: {
    sources: './contracts',
    tests: {
      mocha: './test'
    },
    cache: './cache',
    artifacts: './artifacts'
  },
  networks: {
    // Injective Testnet (inEVM). configVariable is lazy: DEPLOYER_PRIVATE_KEY is
    // only required when a script actually connects to this network.
    injective_testnet: {
      type: 'http',
      url: configVariable('INJECTIVE_RPC_URL', { default: 'https://k8s.testnet.json-rpc.injective.network' }),
      chainId: 1439,
      accounts: [configVariable('DEPLOYER_PRIVATE_KEY')]
    }
  }
});
