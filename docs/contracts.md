# 当前合约

| 合约 | 职责 |
|---|---|
| RightsGovernance | 多成员批准与延时治理 |
| AssetIdentityHub | 登记域内永久资产占用与历史别名保留 |
| CommittedEBLRegistry | 签名签发、版本、背书和质押 |
| RightsController | 发行条件、角色、资格、条款和处置流程 |
| RWAOfferingPoolV5 | 测试代币托管、资金生命周期及分配 |
| ControlledRWAToken | 不可转让整数份额 |
| PaymentOracle | 独立报告付款证明 |
| AgentDecisionLog | 隐私保护的决策批次承诺 |

地址以 public/rights-instance.json 与 public/application-config.json 为准；运行时核对代码及绑定。MockCapitalRegistry、MockUSDC、MockAuthorizationUSDC 和测试辅助合约仅用于本地测试或明确标注的研究资产。

签发方负责登记，holder 同意控制和质押，valuer 提供带范围和有效期的研究估值；compliance 管资格，operator 推进授权业务，attestor 记录付款/到货证明，disposer 提出处置，reviewer 审核，guardian 可以停止新增风险。治理变更受成员批准及延时约束；不同地址不等于独立组织。

投资者付款与份额原子产生，失败募集可退款，实际回款形成可分配资金，投资者分别领取。结清、担保释放、可领取和已领取是不同事实，需要分别表达。份额没有通用 ERC-20/1155 转账或二级市场能力。

当前到期放款、微额回款阻断处置、重复异议及费用顺序问题仍待 N1 修复。现金、份额、增量回款受益权及有界退出的要求见 [规划中的不变量](development-plan.md#5-必须维持的不变量)。

旧材料见 [历史取回说明](history.md)。已部署合约不会因源码清理或本地修复而升级；新候选实例须有独立版本、签名域及账本，并保留旧实例退出。新 Registry/Hub 必须说明跨实例资产占用关系。

当前编译配置为 Solidity 0.8.24、Paris、viaIR、optimizer 200 runs，依赖以锁文件为准。部署前分别检查标准 EVM runtime 与 initcode 限制，不得提高本地大小上限掩盖风险。当前部署脚本拒绝在 artifact 改变后续跑旧实例；新实例发布流程属于 N1.6/N5.2。
