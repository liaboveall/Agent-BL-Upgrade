# Wave B：链上可信与 Agent 可组合

状态：**Gate B 已达成（Injective Testnet，2026-06-29）；2026-10-12 在重新部署的 v2 合约上完成复验，下文证据均为这次复验的结果**。

## 1. 可追溯的付费定价闭环

同一个 `report_hash` 将真实付费报告与链上定价连接起来：

```text
0.001 USDC payment
  → PaidReportEnvelope.report_hash
  → PaymentOracle.PaymentAttested.reportHash
  → RiskPricingOracle.PricingUpdated.evidenceHash
  → RWAOfferingPool #2 final quote = $0.80
```

| 证据 | 值 |
|---|---|
| USDC payment tx | [`0xb8968f…ae90`](https://testnet.blockscout.injective.network/tx/0xb8968f4803c3a68525e183bd70596715004e5b498c44a172d7fbb0423a41ae90) |
| PaidReportEnvelope hash | `0xa2fe04a6469c2c15d3b6282e8282726e3b6973b8800d4ac6ff4619d03ed1b659` |
| `PaymentAttested` tx | [`0x61e0ce…7a31`](https://testnet.blockscout.injective.network/tx/0x61e0ce548607636a95bd04136d5b9b5fcc1f49a92c06412b62d2e9487cd97a31) |
| `PricingUpdated` tx | [`0xd76c82…6dae`](https://testnet.blockscout.injective.network/tx/0xd76c821efd5587eece80928eba5129e8cbdc6570867ef68ec3612cc2f89c6dae) |
| 最终报价 | pool `2`，`$0.80`，`OPEN_OFFERING` |

公开证据见 [`evidence/wave-b-gate.json`](./evidence/wave-b-gate.json)。付费报告正文不公开，证据文件只保留通过运行时 schema 校验的承诺与脱敏字段。

## 2. Injective Testnet 五合约协议

| 合约 | 地址 | 部署交易 |
|---|---|---|
| AgentBLRWA | [`0xEcD538…4e0e`](https://testnet.blockscout.injective.network/address/0xEcD538011b889a7f79566d80A835C74cab2b4e0e) | [`0x5646f0…0fb3`](https://testnet.blockscout.injective.network/tx/0x5646f0b9c3270b4ce02686f4a98fcd40efec510fd008e57344f68197c2ef0fb3) |
| EBLRegistry V2 | [`0x8152FE…cf53`](https://testnet.blockscout.injective.network/address/0x8152FE274497C84850Ce79822feA3B885295cf53) | [`0xbde550…d270`](https://testnet.blockscout.injective.network/tx/0xbde5509c98a5208df82cef84d96efff943f19f92ec58ce55068a92cc5ebcd270) |
| RWAToken | [`0x9CD61A…C11C`](https://testnet.blockscout.injective.network/address/0x9CD61A8A18b22Ea9a6c4A3C36ba465c1488aC11C) | [`0x0ba050…bd18`](https://testnet.blockscout.injective.network/tx/0x0ba0508dc67031e4912c430205f3ec8e69a3f16f0bb5a956614288b5267ebd18) |
| RWAOfferingPool | [`0x38c52c…b310`](https://testnet.blockscout.injective.network/address/0x38c52c33FEC5cc430f19F573768671c47E63b310) | [`0xcd7ad4…9f89`](https://testnet.blockscout.injective.network/tx/0xcd7ad41578e18cb45e0201aa2a21b37d3e2ad27d306c8f88a1b2683800d29f89) |
| RiskPricingOracle | [`0x5A3728…6DDC`](https://testnet.blockscout.injective.network/address/0x5A37286cfb95a0Fc12CDa83d58473E9EC32a6DDC) | [`0x90c080…5072`](https://testnet.blockscout.injective.network/tx/0x90c08062b2050e851ad3562d7815cbca277f0e9267ca2eb3e26e77ed7cfa5072) |

部署脚本会合并而非覆盖 `public/chain-config.json`，随后执行 `mintEBLV2 → pledge → create → subscribe → reprice → pause → resume → settle`。最终链上状态为 `Repaid`，完整交易清单见 [`evidence/wave-b-protocol.json`](./evidence/wave-b-protocol.json)。

## 3. 标准 MCP：9 tools + 3 resources

Wave B 的原始基线是 7 个工具；Mystery Voyage 增加了只读的 `preview_mystery_voyage` 与 `verify_mystery_reveal`，因此当前 surface 为 9 tools + 3 resources。

`npm run mcp:stdio` 使用官方 Model Context Protocol SDK 和 stdio transport，支持 `initialize/listTools/callTool/listResources/readResource`，stdout 仅承载协议帧。

Tools：

1. `get_trade_case`
2. `generate_pricing_quote`
3. `search_knowledge_base`
4. `verify_trade_documents`
5. `purchase_premium_analysis`
6. `simulate_offering`
7. `push_pricing_to_oracle`

Resources：

1. `agentbl://cases/catalog`
2. `agentbl://risk/methodology`
3. `agentbl://contracts/deployments`

所有资源固定为 `application/json`，只公开摘要；未知 URI 返回协议错误。`tests/mcpProtocol.test.js` 通过真实 SDK client 对 Wave B 的 7 个基线工具逐一调用并读取 3 个资源；Mystery Voyage 的 2 个只读工具由当前协议 manifest 额外覆盖。

## 4. 官方 Injective MCP adapter 与安全边界

AgentBL 通过 `InjectiveMcpAdapter` 调用 InjectiveLabs 官方 MCP Server 的 `usdc_native_info` 与 `evm_broadcast`。已完成一次查询和一笔指向 allowlist 合约、value 为 0 的受控 testnet EVM 交易：[`0xc6dbc5…25b6`](https://testnet.blockscout.injective.network/tx/0xc6dbc5ef35af7ce72ca31e7c893b4dbc891b0a278b459685f37d029aa19d25b6)（2026-10-12 复验，目标是重新部署后的 `AgentBLRWA`；证据里记录了官方 checkout 的 commit 和本地改动的 SHA-256）。脱敏 tool trace 见 [`evidence/injective-mcp-smoke.json`](./evidence/injective-mcp-smoke.json)。

所有写操作均 fail-closed：网络固定 `eip155:1439`、目标来自本地部署 allowlist、金额上限 `0.005 USDC`、默认 dry-run。真实写入必须同时具备 `approved=true` 与不进入模型上下文的本地 `MCP_HUMAN_APPROVAL_TOKEN`；raw-EVM smoke 还只允许 `nextPoolId()` 的 selector `0x18e56131`。prompt 或单据正文不参与授权判断。

当前官方 MCP 源码构造 `MsgEthereumTx` 时缺少 protobuf `from` 字段，testnet ante handler 会返回 `sender address missing`。复现官方 raw EVM smoke 前，对官方 checkout 应用仓库中的最小兼容补丁：

```bash
git -C <injective-mcp-server> apply <agentbl>/patches/injective-mcp-msg-sender.patch
npm --prefix <injective-mcp-server> run build
```

AgentBL adapter 另外固定非零 gas price，并将 Ethereum extension 交易的 Cosmos memo 留空；这些是协议兼容参数，不会放宽上述安全策略。

## 5. 复验命令

```bash
npm test
npm --prefix hardhat test
npm run verify:wave-b
npm run mcp:stdio
MCP_LIVE_CONFIRM=injective-testnet npm run smoke:mcp:injective
                              # 需要测试网私钥、gas 与官方 MCP build
npm run preflight
```

`verify:wave-b` 会再次读取 explorer 交易与事件并生成 Gate B 证据；它会发送新的 eBL / offering / pricing testnet 交易。普通离线验收只需 `npm test`，不会自动花费或写链。
