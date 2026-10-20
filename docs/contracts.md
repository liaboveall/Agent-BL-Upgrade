# 合约与资金规则

| 合约 | 职责 |
| --- | --- |
| `RightsGovernance` | 多成员批准与延时治理 |
| `AssetIdentityHub` | 登记域内资产占用与历史别名保留 |
| `CommittedEBLRegistry` | 签名签发、版本、背书与质押 |
| `RightsController` | 角色、资格、条款、发行与处置 |
| `RWAOfferingPoolV5` | 测试代币托管与资金分配 |
| `ControlledRWAToken` | 不可转让整数份额 |
| `RecoveryEntitlements` | 永久认购槽位与烧毁份额后的回款受益权 |
| `PaymentOracle` | 独立报告付款证明 |
| `AgentDecisionLog` | 决策批次的隐私保护承诺 |

当前地址分别见 [实例清单](../public/rights-instance.json)和[应用配置](../public/application-config.json)，二者必须匹配。服务核对实际代码、网络、签名域和合约绑定。Mock 及测试辅助合约只用于本地回归或明确标记的测试资产。

## 资金与权限

签发方登记单证，holder 同意控制和质押，valuer 签署有范围和有效期的研究估值。资格、审核、运营、付款证明及处置分别受角色约束，治理变更需要批准与延时。

认购时付款与份额原子产生；失败募集退回成本。放款受独立放款截止、到期和估值有效期约束，未放款本金有关闭退出路径。部分放款按实际净债务处理。

当前 v2 采用零费、固定通知期和有硬截止的处置规则：回款不重启通知，重复异议不能反复冻结。累计回款按永久认购槽位分配，首次领取烧毁份额后仍可领取迟到回款；领取顺序不改变权益。份额不可转让，无二级交易。

`closeUndisbursed`、Controller 的 `startExit` / `finalizeResolution` 推进到期及处置状态；投资者通过 `refundInvestor` / `claim` 取得既有退出。页面显示的结清、担保释放、可领取和已领取是不同事实，金额核对必须使用原子整数。

## 构建与旧实例

Solidity 0.8.24、Paris、viaIR、optimizer 200 runs，依赖由锁文件固定；标准 EVM runtime 24,576 bytes 和 initcode 49,152 bytes 上限保持有效。

当前控制版本为 2，Rights 签名域为 v2。旧 v1 的 ABI/runtime 位于 `scripts/config/rights-v1-artifacts.json`，保留读取及退出，源码整理不会升级旧合约。新 Registry 共用原 Hub 和治理，继续保留历史占用；不同 Pool 使用独立账本，不能复用旧交易检查点。

`npm run rights:plan` 与 `npm run rights:candidate` 生成无签名计划；`npm run testnet -- status n5-v2-20261019` 查询当前部署记录。部署、激活和资金执行需要显式 `--execute`、干净提交及同提交 CI 收据。已存在实例只能沿原 journal 恢复，不能用新实例 ID 绕过原交易。
