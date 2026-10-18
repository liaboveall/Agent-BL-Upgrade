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

旧合约源码、部署记录及专属测试在 [归档](archive/README.md) 中。已部署合约不会因源码清理或本地修复而升级。当前协议已知问题见综合评估。
