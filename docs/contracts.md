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

Hardhat 依赖安装使用 `npm --prefix hardhat ci`。当前保留 Zod 4.6.7 安全修复，并由 `postinstall` 对 `hardhat-zod-utils` 3.0.8 应用受版本校验的兼容补丁，将错误字段读取改为 Zod 3/4 共用的 `issues`；上游兼容后可移除此补丁。跳过安装脚本时需手动运行 `npm --prefix hardhat run postinstall`。合约测试同时验证无效配置能显示具体字段错误。

当前控制版本为 2，Rights 签名域为 v2。旧 v1 的 ABI/runtime 位于 `scripts/config/rights-v1-artifacts.json`，保留读取及退出，源码整理不会升级旧合约。新 Registry 共用原 Hub 和治理，继续保留历史占用；不同 Pool 使用独立账本，不能复用旧交易检查点。

`npm run rights:plan` 与 `npm run rights:candidate` 生成无签名计划；`npm run testnet -- status n5-v2-20261019` 查询当前部署记录。部署、激活和资金执行需要显式 `--execute`、干净提交及同提交 CI 收据。已存在实例只能沿原 journal 恢复，不能用新实例 ID 绕过原交易。

## 已知限制与下一版合约计划

当前 v2 实例的服务端会把链上 runtime code 与本仓库编译产物逐字节比对（含元数据哈希，见 `src/rights/chain.js`）。因此下列问题**不能在原合约上直接修改**：改动任一受核验合约或其导入的源码（包括注释），都会让已部署的 v2 实例因 `rights_bytecode_mismatch` 无法使用。修复需走新实例流程：先像 v1 一样冻结 v2 的 ABI/runtime 产物供原实例查询与退出，再以新控制版本部署、激活。

| 优先级 | 问题 | 位置 | 下一版处理 |
| --- | --- | --- | --- |
| 中 | 单个 OPERATOR 可在到期前通过 `applyPricingAction` 冻结或触发处置，无治理延时；解冻却需治理。处置后任何人可 `startExit`，3 天后即可定格损失（迟到回款仍可领取） | `RightsController.applyPricingAction`、`startExit` | 到期前的 `TRIGGER_LIQUIDATION` 仅允许治理；`FREEZE_POOL` 保留给 OPERATOR 作紧急刹车 |
| 中 | 募集中途 `REPRICE_DOWN`：先认购者每份成本更高但每份权益相同；且未校验 `tokenSupply × 新价 ≥ minRaise`，降价后全额认购也无法进入 Funded | `RWAOfferingPoolV5.applyPricingAction` | 已有认购后禁止降价，或按份额记录成本并分别结算；降价时校验最低募集额 |
| 中 | 签发机构正常轮换密钥（`setIssuer`）会让其名下全部存量提单 `isActive` 立即为 false，在途池的认购与放款同时停止 | `CommittedEBLRegistry.isActive` | 区分"撤销"与"轮换"：轮换时保留已登记签发人的有效性，只有撤销才使存量失效 |
| 低 | `_releaseCollateral` 的 try/catch 失败后已删除 `poolOfEbl`，且没有重试入口，提单会一直处于质押状态 | `RWAOfferingPoolV5._releaseCollateral` | 增加任何人可调用的 `retryCollateralRelease(poolId)`（仅终态且仍质押给本池） |
| 低 | 单个投资人在同一池最多 32 段不连续认购，超出即 `LotLimit`（前端已给出中文说明） | `RecoveryEntitlements.record` | 合并为按投资人累计的份额区间，或在发行前公开上限 |
| 低 | 一次认购最多 4 次钱包确认（同意条款、授权清零、授权、认购） | `RightsController.acknowledgeTerms` + ERC-20 授权 | 结算资产支持 ERC-3009/EIP-2612 时，用签名授权合并步骤 |
| 可读性 | 大量 `if (!(!x)) revert` 机械转换写法；v2 下不可达的代码（`deductFee`、`setEmergencyStop`、`feeRecipient` 必填但费用恒为 0、未使用的事件/常量）；`recordImporterPayment` 传入的金额会被 `_sealRecovery` 覆盖 | `RWAOfferingPoolV5`、`RightsController` | 新版本一并清理，减少审计面 |

治理固定为"任意 2 名成员批准"，与成员总数无关，且任一成员可单独取消提案；研究实例的角色由同一操作员保管，治理延时目前主要起流程约束作用。
