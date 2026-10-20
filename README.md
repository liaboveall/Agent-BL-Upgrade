# AgentBL

<a href="README.zh-CN.md"><img src="docs/assets/readme-zh.svg" alt="Read in Simplified Chinese" width="132" height="32"></a>

A blockchain research application for trade finance, connecting shipping documents, holder consent, financing terms, test-token custody, and investor exits. The interface supports English and Chinese, with each fund operation authorized by the participant's wallet.

The default research scenario uses fictional copper shipments from Singapore to Shanghai and `TEST_USDC` on Injective EVM Testnet. The application offers a Demo experience and controlled testnet financing.

## Features

- Issue and register research documents, obtain holder consent, and check valuations, eligibility, and material reviews.
- Display and independently verify complete financing terms; require renewed confirmation when the terms, wallet, or quote changes.
- Use test tokens for subscriptions, custody, disbursement, repayment, refunds, loss settlement, and claims.
- Preserve rights to late recoveries after shares are burned, allowing investors to claim separately.
- Browse paginated pools and positions, reconcile on-chain balances, recover unknown transactions, and rebuild the ledger.
- Access deterministic research pricing, AI-assisted analysis, evidence packages, and separate x402 paid reports.

AI provides analysis and explanations. It cannot sign for participants or disburse funds autonomously. Report payments and financing funds are accounted for separately.

## Delivery status

The current v2 instance has completed testnet deployment, configuration switching, all three funding paths, late recoveries, ledger reconciliation, and local container recovery verification. The legacy v1 instance retains a separate exit service. When the existing local deployment is running, use:

| Service | URL |
| --- | --- |
| Current v2 financing and positions | <http://127.0.0.1:3000/#/finance> |
| Legacy v1 queries and exits | <http://127.0.0.1:3001/#/finance> |

**The only remaining acceptance task is for someone who did not develop the application to operate a wallet and independently verify balances.** See [Human acceptance](docs/acceptance.md) for the procedure and required records. Automated wallets and browser tests do not replace this acceptance.

Follow-up projects for real phones, independent-host recovery, signing authority handover, and commercial admission have been removed from this delivery scope. Cancellation does not mean those capabilities have been verified. The application remains limited to research test assets and does not process real trade financing.

## Run locally

Requires Node.js **22.13 or later** and npm. Node.js 24 is recommended.

```sh
npm ci
npm --prefix hardhat ci
npm run compile:contracts
npm run dev
```

Open <http://127.0.0.1:3000/#/finance>. The `dev` command builds the frontend before starting the server; use `npm start` for an existing build. If a running deployment already occupies port 3000, set another `PORT` in your `.env` and use a separate `AGENTBL_RUNTIME_DIR`.

Demo requires no wallet private key or model API key. For custom configuration, copy [.env.example](.env.example) to `.env` and fill in the settings for the features you enable. Do not overwrite an existing `.env`.

### Controlled testnet

- Network: Injective EVM Testnet, chain ID **1439**.
- [application-config.json](public/application-config.json): frontend network and contract configuration.
- [rights-instance.json](public/rights-instance.json): controlled instance and deployment manifest.
- The server selects its manifest through `AGENTBL_RIGHTS_CONFIG`; both public configurations must refer to the same instance.
- Connect a registered wallet with the required permissions, switch to Live, and follow the role workspace. The server needs administrator authentication, a material encryption key, and a persistent runtime directory. See [Operations](docs/operations.md).

Instance materials, transaction checkpoints, and ledgers are persistent application state. Do not copy legacy instance data into a new pool directory or delete checkpoints to replay historical transactions.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the React interface into `dist/` |
| `npm run dev:web` | Start the frontend development server separately |
| `npm run lint` / `npm run check` | Check code, configuration, assets, and source consistency |
| `npm test` / `npm run test:coverage` | Run application regressions and coverage checks |
| `npm run test:contracts` | Run Solidity contract regressions |
| `npm run test:capital` / `npm run test:rights` | Exercise capital and rights flows on a real local EVM |
| `npm run test:evidence` / `npm run test:operations` | Check evidence, payments, shutdown, and recovery |
| `npm run test:finance` | Verify role workflows and pagination across 25 pools |
| `npm run test:browser` | Run bilingual browser, keyboard, and wallet-context regressions |
| `npm run build:clean` | Compare two clean builds |
| `npm run verify:release` | Run the complete local delivery checks in a fresh checkout |
| `npm run terms:verify -- <terms.json>` | Verify public financing terms offline |
| `npm run mcp:stdio` | Start the MCP interface over standard input/output |
| `npm run smoke:x402` / `npm run x402:intel` | Use report-payment checks and intelligence utilities |

Before running browser tests for the first time, run `npx playwright install chromium`, or point `AGENTBL_CHROMIUM_PATH` to an available Chrome/Edge executable. CI checks the application, contracts, integrations, browser behavior, builds, containers, and dependencies. Each change is assessed using its own commit's results.

## Repository layout

```text
src/          API, ledger, rights, pricing, Agent, and payments
web/          Bilingual React interface
hardhat/      Contracts, contract tests, and compiler configuration
public/       Public instance configuration and browser assets
data/         Research samples, source corpora, and separate runtime state
scripts/      Maintenance, validation, testnet, and backup tools
tests/        Application, integration, and browser regressions
docs/         Current references and the remaining human acceptance task
```

`data/runtime/`, `.env`, dependencies, build output, and test artifacts are excluded from Git. Historical development plans, review reports, and phase-specific scaffolding have been removed from the current tree; older versions remain available in Git history.

## Technology and scope

The frontend uses React, Vite, and ethers; the server uses Node.js and Express; contracts use Solidity and Hardhat. Off-chain materials are encrypted, cash facts are appended to JSONL, snapshots can be rebuilt, and each runtime directory allows one writer.

Contracts constrain registered assets, authorizations, and test tokens deposited into them. Material hashes do not prove real goods or legal claims, and the system does not automatically prevent duplicate financing outside its registry domain. Multiple research addresses do not represent independent organizations, and test tokens are not real dollars. Shares are non-transferable, with no secondary trading.

- [Architecture and trust boundaries](docs/architecture-current.md)
- [Contracts and funding rules](docs/contracts.md)
- [Operations, backup, and maintenance](docs/operations.md)
- [Research data and optional models](docs/data-sources.md)
- [Human acceptance](docs/acceptance.md)

Supporting documents under `docs/` are currently written in Chinese.
