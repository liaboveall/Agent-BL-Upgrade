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

当前 v3 沿用 v2 的零费、固定通知期和有硬截止的处置规则：回款不重启通知，重复异议不能反复冻结。累计回款按永久认购槽位分配，首次领取烧毁份额后仍可领取迟到回款；领取顺序不改变权益。份额不可转让，无二级交易。

v3 另有四条规则：

- **清算权限**：到期前只有延时治理能对池执行 `TRIGGER_LIQUIDATION`；OPERATOR 仍可 `FREEZE_POOL` 作紧急刹车，到期后也可启动清算。
- **价格锁定**：首笔认购后价格固定，任何改价都返回 `HasSubscribers`；此前的降价须满足 `tokenSupply × 新价 ≥ minRaise`。
- **签发人密钥**：`setIssuer` 只是轮换，旧密钥已签发的提单继续有效；只有 `revokeIssuer` 撤销某把密钥，才使它签发的提单失效，且被撤销的密钥不能再设为签发人。
- **抵押释放重试**：池进入终态（Repaid、LossSettled，或已无募集款的 Cancelled）后，若当场释放质押失败，任何人都可调用 `retryCollateralRelease(poolId)` 重试。提单已释放或已被更新的发行占用时，调用返回 `false`，不改变状态。

每个钱包在同一池最多 32 段不连续认购（`RecoveryEntitlements.MAX_LOTS`，可用 `lotCount` 查询已用段数）。该上限写入 v3 发行披露政策的 `max_subscription_segments_per_investor`，并由披露哈希绑定到签名条款。

`closeUndisbursed`、Controller 的 `startExit` / `finalizeResolution` 推进到期及处置状态；投资者通过 `refundInvestor` / `claim` 取得既有退出。页面显示的结清、担保释放、可领取和已领取是不同事实，金额核对必须使用原子整数。

## 构建与旧实例

Solidity 0.8.24、Paris、viaIR、optimizer 200 runs，依赖由锁文件固定；标准 EVM runtime 24,576 bytes 和 initcode 49,152 bytes 上限保持有效。

Hardhat 依赖安装使用 `npm --prefix hardhat ci`。当前保留 Zod 4.6.7 安全修复，并由 `postinstall` 对 `hardhat-zod-utils` 3.0.8 应用受版本校验的兼容补丁，将错误字段读取改为 Zod 3/4 共用的 `issues`；上游兼容后可移除此补丁。跳过安装脚本时需手动运行 `npm --prefix hardhat run postinstall`。合约测试同时验证无效配置能显示具体字段错误。

当前控制版本为 3，Rights 签名域为 v3。旧实例按冻结的 ABI/runtime 逐字节核验：v1 用 `scripts/config/rights-v1-artifacts.json`，v2 用 `scripts/config/rights-v2-artifacts.json`。两者都只保留读取与退出，源码整理不会升级旧合约。新 Registry 共用原 Hub 和治理，继续保留历史占用；不同 Pool 使用独立账本，不能复用旧交易检查点。

旧 v2 实例在应用内只接受不增加风险的操作：回款、付款与到港证明、结清、违约、处置的通知/审核/异议/终局及 `startExit`；投资者的退款与领取不受影响。v2 发行披露不含 `control_version` 字段，按原 v2 政策和签名域核验；v3 披露写明 `control_version: 3`，两者不能互换。

`npm run rights:plan` 与 `npm run rights:candidate` 生成无签名计划；`npm run testnet -- status n5-v3-20261027` 查询当前部署记录，`npm run testnet -- status n5-v2-20261019` 查询旧 v2。部署、激活和资金执行需要显式 `--execute`、干净提交及同提交 CI 收据。已存在实例只能沿原 journal 恢复，不能用新实例 ID 绕过原交易。

## v2 → v3 迁移与已知限制

服务端把链上 runtime code 与对应版本的产物逐字节比对（含元数据哈希，见 `src/rights/chain.js`）。因此问题不能在已部署合约上直接修改，只能冻结旧版本产物，再以新控制版本部署。下表前四项已在 v3 修复；**旧 v2 链上实例仍保留原行为**，修改源码不会修复它。

| 优先级 | 问题（v2） | 位置 | 状态 |
| --- | --- | --- | --- |
| 中 | 单个 OPERATOR 可在到期前通过 `applyPricingAction` 触发处置，无治理延时；处置后任何人可 `startExit`，3 天后即可定格损失 | `RightsController.applyPricingAction` | v3 已修复：到期前仅延时治理可清算，OPERATOR 保留 `FREEZE_POOL` |
| 中 | 募集中途 `REPRICE_DOWN`：先认购者每份成本更高但权益相同；且未校验 `tokenSupply × 新价 ≥ minRaise` | `RWAOfferingPoolV5.applyPricingAction` | v3 已修复：首笔认购后禁止改价，降价校验最低募集额 |
| 中 | 签发机构轮换密钥（`setIssuer`）会让其名下全部存量提单立即失效，在途池的认购与放款同时停止 | `CommittedEBLRegistry.isActive` | v3 已修复：轮换保留存量，`revokeIssuer` 才使其失效 |
| 低 | `_releaseCollateral` 的 try/catch 失败后已删除 `poolOfEbl`，且没有重试入口 | `RWAOfferingPoolV5._releaseCollateral` | v3 已修复：`retryCollateralRelease(poolId)` |
| 低 | 单个投资人在同一池最多 32 段不连续认购，超出即 `LotLimit` | `RecoveryEntitlements.record` | v3 在发行披露中公开上限，前端认购确认同样提示；上限本身保留 |
| 低 | 一次认购最多 4 次钱包确认（同意条款、授权清零、授权、认购） | `RightsController.acknowledgeTerms` + ERC-20 授权 | 保留；结算资产支持 ERC-3009/EIP-2612 时可用签名授权合并 |
| 可读性 | `if (!(!x)) revert` 机械转换写法；不可达代码（`deductFee`、`setEmergencyStop`、恒为 0 的费用字段）；`recordImporterPayment` 的金额会被 `_sealRecovery` 覆盖 | `RWAOfferingPoolV5`、`RightsController` | 保留；清理会改变条款签名类型和 ABI，留待下一版 |

迁移按以下完成标准执行：

1. **冻结 v2**：v2 的 ABI/runtime 写入 `scripts/config/rights-v2-artifacts.json`，与已部署字节码逐字节一致。服务据此核验原实例，原实例只保留读取、退款、领取与处置退出。回归测试 `loads frozen v2 code after recompilation` 证明：旧实例在新源码下仍可核验，并仍按原规则运行。
2. **v3 合约测试**：`hardhat/test/controlV3.test.js` 覆盖上述四项修复、32 段上限与披露的一致性，以及 JS 与 Solidity 条款哈希的一致性；原有用例已按新规则更新。
3. **部署与激活**：v3 以独立实例 `n5-v3-20261027` 部署、激活（使用 `--execute` 和同提交 CI 收据），共用原治理与 Hub，Pool、账本与恢复检查点独立；部署记录用 `npm run testnet -- status n5-v3-20261027` 查询。激活后用 `npm run testnet -- funding n5-v3-20261027 --execute` 在测试网验证资金路径：正常兑付与失败募集退款已通过；损失路径要等 1 天处置通知期，到期后需再运行一次。

治理固定为"任意 2 名成员批准"，与成员总数无关，且任一成员可单独取消提案；研究实例的角色由同一操作员保管，治理延时目前主要起流程约束作用。

## 下一控制版本（v4）候选

以下问题只能通过新控制版本修复；v3 已部署合约保持原行为，应用层的缓解方式一并列出。

| 问题（v3） | 影响 | 应用层现状 |
| --- | --- | --- |
| 到期后任何人可 `startExit` 立即标记违约并锁定处置提案 | 即将回款的池被迫进入最长 3 天的现金处置 | 页面显示处置进度、通知期与硬截止 |
| `REPRICE_DOWN` 不经持有人重新同意即改变发行价 | 与持有人签署的质押条款不一致 | 应用不提供改价；改价后的池在条款核对时被拒绝认购 |
| 任一治理成员可单独取消提案 | 单人否决 | 无 |
| 零认购且过期的池只能由运营方 `cancelOffering` | 持有人无法自行取回质押单证 | 工作台提供“取消无人认购的发行”，列表标为“零认购已截止” |
| 部分募集需要单独的 `finalizeFunding` 才能放款 | 遗漏时只能在放款截止后退回本金 | 工作台提供“关闭已达最低额的募集”，列表标为“待关闭募集” |
| 来源审查（≤24 小时）是全局开关 | 漏刷新一次，所有池同时停止认购与放款 | 列表显示 `screening_expired` 原因；需合规角色按期刷新 |
| 估值最长 30 天且不能续期 | 认购与放款必须在估值期内完成 | 详情显示估值有效期，过期显示 `valuation_expired` |
| `clearRiskLock` 要求全部份额已销毁 | 任一出资人不领取，单证风险锁无法解除 | 无 |
| 退款不减少 `subscribed`；`Repriced` 状态从不设置 | 已取消池显示历史认购份数；死状态 | 页面把已全部退款的池显示为 0 份并注明已退款 |
