# Protocol v3 测试网部署与交付核验（2026-10-17）

用户要求“部署，并执行需要的交易”。基线提交 `8afdb2c2672613773857f8ede905389bd379f6cb`，已完成 **4 个新核心合约部署 + 3 笔必要初始化**。全部在 Injective EVM Testnet **1439**，不是 mainnet 或对外应用托管发布。[官方网络信息](https://docs.injective.network/developers-evm/network-information) 与实际 RPC 链号交叉确认。具体范围与费用上限见 [逐笔计划](plan.md)。

## 实际部署与交易

| 步骤 | 操作 | 交易 | 区块 |
|---|---|---|---|
| 0 | deploy:EBLRegistry | [0x92cb542583…](https://testnet.blockscout.injective.network/tx/0x92cb5425833292a4fe03e595325c8b12c7cdfa5f5d2e0af9dd3c986b2bbe1bd0) | 144149745 |
| 1 | deploy:RWAToken | [0x43067e5e12…](https://testnet.blockscout.injective.network/tx/0x43067e5e1235f5c9e70f43ab139a22b3ba3e6ad5897a060e3fc044c2816e4a85) | 144149773 |
| 2 | deploy:RWAOfferingPool | [0x3674b349e5…](https://testnet.blockscout.injective.network/tx/0x3674b349e51669de521f4989f35e15cd5dd9652d9e76f9d3f8ae6256f96c35d0) | 144149806 |
| 3 | deploy:RiskPricingOracle | [0xfd5afa06c5…](https://testnet.blockscout.injective.network/tx/0xfd5afa06c5a23cb480496b35ce931025a4cdfe42b00195b587d12a765b10f60b) | 144149830 |
| 4 | RWAToken.setPool | [0xbe3cfb81bc…](https://testnet.blockscout.injective.network/tx/0xbe3cfb81bc23588a8f544b6f8354f9a5a7e4f40074cfbb7c7b4c2467ed824cfd) | 144149859 |
| 5 | RWAOfferingPool.setOracle | [0x78d778423d…](https://testnet.blockscout.injective.network/tx/0x78d778423de8ef29893bc77cdfd36495f4d44b20e294ba637a2477fcc45c43a8) | 144149881 |
| 6 | RiskPricingOracle.setUpdater | [0x3968bef579…](https://testnet.blockscout.injective.network/tx/0x3968bef579f9dcb3d5aeb9974e2511e180736f71c141fa8e5071dc9587c15960) | 144149907 |

| 新核心合约 | 地址 |
|---|---|
| EBLRegistry | [0xa89D5Bf56F753Ba064EEbE43A222773d0A54E612](https://testnet.blockscout.injective.network/address/0xa89D5Bf56F753Ba064EEbE43A222773d0A54E612) |
| RWAToken | [0x541E3C70347F942e55A98EF76F744b145F88Ab8C](https://testnet.blockscout.injective.network/address/0x541E3C70347F942e55A98EF76F744b145F88Ab8C) |
| RWAOfferingPool | [0xE8FDb7ec3638e84bE43F3f8dbC2d4D3a93E829D6](https://testnet.blockscout.injective.network/address/0xE8FDb7ec3638e84bE43F3f8dbC2d4D3a93E829D6) |
| RiskPricingOracle | [0x4F0E48634a0811de0bD29f7e2738c69343ab836F](https://testnet.blockscout.injective.network/address/0x4F0E48634a0811de0bD29f7e2738c69343ab836F) |

`plan.json` 绑定精确 nonce 39–45、交易 data、value=0、gas、预测地址与创建/运行字节码哈希；签名前估算 gas，广播前先落盘交易哈希，检查点丢失/超时只读对账，绝不盲重发。执行日志与 `transaction-0.json` 至 `transaction-6.json` 保留。

[只读链核验与本地配置切换](live-verification-and-activation.json)逐笔核对 sender、to、data、nonce、chain、value、gas、规范区块、成功回执、创建地址和初始化事件；全部 7 份当前合约字节码 **MATCH**，连接、owner 与专用 updater 授权正确。通用 `verify-bytecode.mjs --strict --json` 再核验通过，见 `bytecode-active-final.json`。owner 的 latest/pending nonce 同为 **46**。

账户实际扣费 **0.001728 INJ**，等于本次 `gasLimit × gasPrice` 合计；回执 `gasUsed × effectiveGasPrice` 合计 **0.00098817968 INJ**。两者分别记录，没有将回执成本冒充余额扣减。

## 资产与运行时保全

旧 Registry/Token/Pool/Oracle 完整配置存入 `public/chain-config.json` 的 `legacyProtocols`，原始快照另存 `chain-config-before.json`。AgentBLRWA、PaymentOracle、AgentDecisionLog 三份辅助合约沿用原地址；只授权现有专用定价账户，没有新执行密钥，也没有多余的 owner executor 授权。

[旧资产盘点](legacy-inventory-before.json)与部署后读取确认：旧 eBL #1/#2/#3 的身份、holder、质押，旧池的每个 Offering 字段、份额总量、owner 持仓、报价/证据承诺及 emergency stop 均不变。旧 pool #1 的 10000 份已结清测试记录继续保留；pool #2/#3 无认购份额，但仍留在旧地址和旧质押。没有解押、取消、重铸或迁移这些资产。新 Registry / Pool 为空，next ID 均为 1；池编号必须连同合约地址解释。

Agent 的审批、决策、事件、游标、单证索引和池映射改用 `protocol-v3-<pool地址>/` 命名空间，保留旧文件。新部署不自动关联旧 #2/#3，也不把新 #1 标为旧历史 smoke。监听器校验归档地址及部署块/规范部署回执后，只允许沿用的辅助合约从新协议起点开始观察；新的核心合约和未归档地址仍不能跳过历史。旧提单在新 Registry 缺失时继续阻止开盘，不能换 case ID 重铸。

[实际 RPC 只读启动核验](live-readonly-startup-final.json)：Live/observe，未加载 signer，pending approvals=0，映射为空；监听为 **healthy**、lag=0、stale=false，无重组/对账错误。临时 runtime 用完后删除；没有伪称常驻服务或远程网站已经上线。

## 切换后本地验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 构建 / lint | 通过 | `postactivation-build.log`、`lint-final.log` |
| 全量应用 | **1311 / 1311**，零跳过/取消 | `postactivation-coverage-final.log` |
| 覆盖率（src/**） | **94.67% 行 / 85.21% 分支 / 92.59% 函数** | 同上 |
| Solidity | **92 / 92**，preflight 重跑 | `preflight-final.json` |
| Chromium 桌面 | **8 / 8**，零 flaky/跳过 | `postactivation-browser.log`、`browser-final.json` |
| Agent 评测 | **20 / 20**，44 对话/100 轮，1350 定价、26 注入案例；Live LLM SKIP | `evaluation-final.log` |
| Preflight | **66 PASS / 0 WARN / 5 Live SKIP / 0 FAIL** | `preflight-final.json`、`preflight-final.log` |

部署工具新增回归覆盖 7 笔交易的精确构造、接受广播后超时不重发、规范回执/字节码/事件、nonce 和 gas 拒绝、替换地址隔离、同号池标题映射，以及归档辅助历史的严格边界。历史 v2 夹具改为显式使用归档配置，不再隐式依赖“当前默认部署仍是 v2”。实际 v3 另有新行为回归与上面的实时 RPC 验证。

## 保留的失败与外部边界

`postactivation-coverage-1.log` 保留首次切换后 16 项失败：13 项历史 Live 夹具仍依赖默认 v2 bootstrap，2 项持久性测试硬编码旧 runtime 根路径，1 项 README 地址未同步；均修正后全量重跑。`postactivation-targeted-2.log` 另保留新增断言误写 ready/实际 healthy 的失败。`live-readonly-startup.json` 保留首次监听的 degraded 状态：沿用辅助合约的历史边界需要显式验证归档，后来修复并实链只读重验通过。所有失败与最终通过分开保存。

本次只执行 7 笔部署初始化，没有 USDC 付款、虚构付款/到港证明、认购、结算、损失处理、旧池变更、首次 anchorBatch 或后台锚定。资金托管与兑付、企业 eBL 法律/货权控制、真实业务数据/模型、正式身份权限、生产运维与独立恢复仍按原评估保留边界。当前 v3 合约仍不托管和兑付稳定币。

`completion.json` 记录本地交付时点（提交/远程 CI 尚待核验）；`source-manifest.json` 绑定提交的 Git 文件字节，`artifact-manifest.json` 绑定本目录证据。原评估、整改和前次交付记录保持原时点，不改写为此次部署证明。
