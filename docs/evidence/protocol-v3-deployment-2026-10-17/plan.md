# Protocol v3 测试网部署计划

2026-10-17；用户已明确要求“部署，并执行需要的交易”。本计划执行升级所需的 7 笔部署/初始化，不重新铸造旧货权、不迁移持仓、不生成付款证明。

网络：Injective EVM Testnet，chain ID 1439。[官方网络信息](https://docs.injective.network/developers-evm/network-information) 与实时 RPC 已交叉确认。owner：`0x9da22292D85e2A584ace6bb347D7054486b5ed6B`；现有专用定价账户：`0xEB43623667f1Add616D0FbdEBbbE067a0F195F79`。

| 步骤 | nonce | 操作 | 合约地址 |
|---|---|---|---|
| 0 | 39 | deploy:EBLRegistry | `0xa89D5Bf56F753Ba064EEbE43A222773d0A54E612` |
| 1 | 40 | deploy:RWAToken | `0x541E3C70347F942e55A98EF76F744b145F88Ab8C` |
| 2 | 41 | deploy:RWAOfferingPool | `0xE8FDb7ec3638e84bE43F3f8dbC2d4D3a93E829D6` |
| 3 | 42 | deploy:RiskPricingOracle | `0x4F0E48634a0811de0bD29f7e2738c69343ab836F` |
| 4 | 43 | RWAToken.setPool | `0x541E3C70347F942e55A98EF76F744b145F88Ab8C` |
| 5 | 44 | RWAOfferingPool.setOracle | `0xE8FDb7ec3638e84bE43F3f8dbC2d4D3a93E829D6` |
| 6 | 45 | RiskPricingOracle.setUpdater | `0x4F0E48634a0811de0bD29f7e2738c69343ab836F` |

全部 value=0，gasPrice=160000000 wei，合计 gas 上限 10800000；预留费用 0.001728 INJ，规划总上限 0.003 INJ。此前 owner 余额 0.634937158615 INJ，latest/pending nonce 都为 39。不同于回执 gasUsed，Injective 可能按 gasLimit 收取；会分别记录并核对余额变化。

每步发送前校验链号、身份、精确 nonce、字节码、gas 估算及前序规范回执，签名后先写入交易哈希检查点，再广播一次。不明结果只按已记录哈希对账，绝不盲重发。旧 pool #2/#3 没有认购份额，但继续保留原地址、质押和状态；旧 #1 的 10000 份历史测试持仓也保留。新 Registry 为空；新旧 pool 编号没有迁移含义。新 Agent runtime 按新 pool 合约地址隔离审批、事件、游标与映射，旧目录原样保留。旧已登记提单在新 Registry 缺失时继续拒绝重铸。

初始化仅连接新 Token / Pool / Oracle 并授权现有定价账户；owner 已具备执行权限，不发送多余 setAgentExecutor，也不新建执行密钥。AgentBLRWA、PaymentOracle、AgentDecisionLog 沿用既有地址。首次锚定、后台锚定、稳定币付款、旧池终态/解押及 mainnet 不属于本计划。
