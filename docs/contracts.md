# 当前合约

| 合约 | 职责 |
|---|---|
| RightsGovernance | 多成员批准与延时治理 |
| AssetIdentityHub | 登记域内永久资产占用与历史别名保留 |
| CommittedEBLRegistry | 签名签发、版本、背书和质押 |
| RightsController | 发行条件、角色、资格、条款和处置流程 |
| RWAOfferingPoolV5 | 测试代币托管、资金生命周期及分配 |
| ControlledRWAToken | 不可转让整数份额 |
| RecoveryEntitlements | 新候选的永久认购槽位，累计现金分配及份额销毁后的增量受益权 |
| PaymentOracle | 独立报告付款证明 |
| AgentDecisionLog | 隐私保护的决策批次承诺 |

地址以 public/rights-instance.json 与 public/application-config.json 为准；运行时核对代码及绑定。MockCapitalRegistry、MockUSDC、MockAuthorizationUSDC 和测试辅助合约仅用于本地测试或明确标注的研究资产。

签发方负责登记，holder 同意控制和质押，valuer 提供带范围和有效期的研究估值；compliance 管资格，operator 推进授权业务，attestor 记录付款/到货证明，disposer 提出处置，reviewer 审核，guardian 可以停止新增风险。治理变更受成员批准及延时约束；不同地址不等于独立组织。

投资者付款与份额原子产生，失败募集可退款，实际回款形成可分配资金，投资者分别领取。结清、担保释放、可领取和已领取是不同事实，需要分别表达。份额没有通用 ERC-20/1155 转账或二级市场能力。

控制版本 2 的本地新候选已实现签署放款截止、来源复核、无放款本金关闭、部分放款净债务、固定通知/终局和零费政策。处置版本由 `resolutionId` 标识，事件包含硬截止和绑定版本的异议 ID；重复异议不能再次冻结。实际回款不改通知时间，原投资者在烧毁份额后可继续领取增量；最多 32 段不连续认购和 1,000,000 份限制给出有界计算与尾差。

`closeUndisbursed`、Controller 的 `startExit`/`finalizeResolution` 是到期退出入口；资金持有人自行 `refundInvestor`/`claim`。部分放款的目标、迟到回款、尾差正反例见 [N0 政策](development-plan.md#n02-决策第一阶段可执行政策)。现金及签名不变量见 [I01～I14](development-plan.md#5-必须维持的不变量)。验证结论以计划交付记录为准。

旧材料见 [历史取回说明](history.md)。已部署合约不会因源码清理或本地修复而升级；新候选实例须有独立版本、签名域及账本，并保留旧实例退出。新 Registry/Hub 必须说明跨实例资产占用关系。

当前编译配置为 Solidity 0.8.24、Paris、viaIR、optimizer 200 runs，依赖以锁文件为准。新候选移除无资金条款的旧创建入口、可变期限 setter 和重复 pause/resume 入口；风险暂停/恢复仍经受控 `applyPricingAction` 执行。Controller 不再在自身构造中嵌入整个资金池和代币的创建代码，降低 initcode；标准 runtime 24,576 / initcode 49,152 bytes 上限不变。

旧实例的 ABI/runtime 单独冻结，不能用新 ABI 解释旧条款。`deploy:w5` 仅保留旧实例 status；`rights:candidate` 生成新命名空间的未签名事务，默认共用已有治理/Hub，并记录旧配置。实际部署与双配置切换属于 N5.2，本地发布准备不算测试网部署。
