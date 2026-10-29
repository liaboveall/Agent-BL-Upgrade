# 合约与资金规则

| 合约 | 职责 |
| --- | --- |
| `RightsGovernance` | 两名成员批准、两名成员取消的延时治理（v4 起每个实例一份） |
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

源码当前为**控制版本 4**；公共测试网上运行的仍是已部署的 v3 实例 `n5-v3-20261027`，在 v4 实例部署并切换配置之前，应用把它当作旧版本、只保留退出（见下文“v3 → v4”）。

v4 沿用 v2 的零费、固定通知期和有硬截止的处置规则：回款不重启通知，重复异议不能反复冻结。累计回款按永久认购槽位分配，首次领取烧毁份额后仍可领取迟到回款；领取顺序不改变权益。份额不可转让，无二级交易。

v3 引入、v4 保留的四条规则：

- **清算权限**：到期前只有延时治理能对池执行 `TRIGGER_LIQUIDATION`；OPERATOR 仍可 `FREEZE_POOL` 作紧急刹车，到期后也可启动清算。
- **价格锁定**（v4 收紧，见下）：v3 中首笔认购后价格固定，此前的降价须满足 `tokenSupply × 新价 ≥ minRaise`。
- **签发人密钥**：`setIssuer` 只是轮换，旧密钥已签发的提单继续有效；只有 `revokeIssuer` 撤销某把密钥，才使它签发的提单失效，且被撤销的密钥不能再设为签发人。
- **抵押释放重试**：池进入终态（Repaid、LossSettled，或已无募集款的 Cancelled）后，若当场释放质押失败，任何人都可调用 `retryCollateralRelease(poolId)` 重试。提单已释放或已被更新的发行占用时，调用返回 `false`，不改变状态。

v4 新增五条规则（2026-10-29 综合评估的 F02/F03/F05/F06/F07）：

- **质押释放绑定具体质押（F02）**：Registry 为每次质押分配 `pledgeId`，Controller 在发行时记下 `pledgeOf[poolId]`。释放只对“最新发行所依据的那一次质押”生效：旧终态池的 `retryCollateralRelease` 不能解除持有人之后的新质押，无论新池是否已创建；持有人撤回未发行质押也按 `pledgeId` 判断，按同一条款重新质押同样可以撤回。一次质押只支持一个发行：该发行结束后，下一次发行需要持有人重新质押同意。
- **受控池不改价（F03）**：`applyPricingAction` 只接受暂停、冻结、清算和恢复（action 3–6），运营方和治理都不能改发行价；价格始终等于持有人质押、估值方签署的条款价格，`quoteVersion` 保持 1。新价格只能取消后以重新同意的新条款另行发行。
- **只有真实欠款才违约（F05）**：`markDefault` 要求到期且 `outstandingDebt > 0`。到期时托管现金已覆盖全部目标分配的池，任何人调用 `startExit`（或 `closeUndisbursed`）即按 Repaid 结清并释放质押，不再进入 Defaulted 和三天现金处置；冻结中的池需先由治理解冻。
- **无人认购可自行退出（F06）**：募集截止后仍无人认购的池，任何人可调用 `startExit` 取消发行并释放单证，无需运营方；冻结中的池除外。截止当秒仍可认购，因此截止之后才可取消。
- **取消同样需要两人（F07）**：已获两人批准的治理操作，需两名成员投票才能取消（`CancelVoted` / `Cancelled`）；尚未获第二人批准的提案可由其唯一批准人撤回。单人紧急刹车仍由 GUARDIAN `setIntakeStopped(true)` 与 OPERATOR `FREEZE_POOL` 提供。治理合约代码改变，因此 v4 实例部署自己的 RightsGovernance；共享 Hub（含历史占用）仍归原治理所有，由它登记新 Registry。

另外删除了 Controller 中不可达的 `deductFee`（累计领取模式下池合约一律拒绝收费）。v4 编译后运行时字节码：`RWAOfferingPoolV5` 24,367、`RightsController` 24,361 字节，分别距 EIP-170 上限 209、215 字节；下一版本若再增加逻辑，应先拆分模块或库，而不是删减授权与恢复检查。

每个钱包在同一池最多 32 段不连续认购（`RecoveryEntitlements.MAX_LOTS`，可用 `lotCount` 查询已用段数）。该上限写入 v3/v4 发行披露政策的 `max_subscription_segments_per_investor`，并由披露哈希绑定到签名条款。

`closeUndisbursed`、Controller 的 `startExit` / `finalizeResolution` 推进到期及处置状态；投资者通过 `refundInvestor` / `claim` 取得既有退出。页面显示的结清、担保释放、可领取和已领取是不同事实，金额核对必须使用原子整数。

## 构建与旧实例

Solidity 0.8.24、Paris、viaIR、optimizer 200 runs，依赖由锁文件固定；标准 EVM runtime 24,576 bytes 和 initcode 49,152 bytes 上限保持有效。

Hardhat 依赖安装使用 `npm --prefix hardhat ci`。当前保留 Zod 4.6.7 安全修复，并由 `postinstall` 对 `hardhat-zod-utils` 3.0.8 应用受版本校验的兼容补丁，将错误字段读取改为 Zod 3/4 共用的 `issues`；上游兼容后可移除此补丁。跳过安装脚本时需手动运行 `npm --prefix hardhat run postinstall`。合约测试同时验证无效配置能显示具体字段错误。

当前控制版本为 4，Rights 签名域为 v4。旧实例按冻结的 ABI/runtime 逐字节核验：v1 用 `scripts/config/rights-v1-artifacts.json`，v2 用 `scripts/config/rights-v2-artifacts.json`，v3 用 `scripts/config/rights-v3-artifacts.json`（2026-10-29 冻结，与 `n5-v3-20261027` 部署候选中的产物逐字节相同）。三者都只保留读取与退出，源码整理不会升级旧合约。v4 Registry 共用原 Hub（继续保留历史占用），但使用自己的治理；服务核验 Hub 的治理是已知版本的 RightsGovernance（冻结产物之一或本实例同版本）、至少 3 名成员且延时 ≥ 1 小时。不同 Pool 使用独立账本，不能复用旧交易检查点。

旧实例在应用内只接受不增加风险的操作：v2 为回款、付款与到港证明、结清、违约、处置的通知/审核/异议/终局、`startExit` 与取消无人认购的发行；v3 另加 `retryCollateralRelease`。投资者的退款与领取不受影响。v2 发行披露不含 `control_version` 字段，按原 v2 政策和签名域核验；v3、v4 披露分别写明 `control_version: 3` / `4`，按各自政策（`FINANCE_POLICY_V3` 与 v3 文本逐字节相同）和签名域核验，不能互换。

`npm run rights:plan` 与 `npm run rights:candidate` 生成无签名计划（v4 候选输入需给出共享 Hub 的治理 `governance`、新实例治理的三名成员 `members` 与延时 `delay`）；`npm run testnet -- status n5-v3-20261027` 查询当前部署记录，`npm run testnet -- status n5-v2-20261019` 查询旧 v2。部署、激活和资金执行需要显式 `--execute`、干净提交及同提交 CI 收据。已存在实例只能沿原 journal 恢复，不能用新实例 ID 绕过原交易。

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

v3 及更早的共享治理为"任意 2 名成员批准、任一成员可单独取消"；v4 治理取消也需两人。研究实例的角色由同一操作员保管，治理延时目前主要起流程约束作用，不能当作独立多方控制的业务证据。

## v3 → v4 迁移

已完成（源码与本地验证）：

1. **冻结 v3**：`scripts/config/rights-v3-artifacts.json`；`src/rights/chain.js` 用它核验已部署的 v3 实例，v3 只保留退出。回归 `loads frozen v3 code after the version 4 edits` 在本地链部署冻结的 v3 产物，证明它仍可核验、只保留退出，且旧规则（单人取消治理提案）仍在。
2. **v4 合约测试**：`hardhat/test/controlV4.test.js` 把综合评估 R1–R5 反例改写为反向断言（旧池重试不能释放新质押、拒绝任何改价、足额回款按 Repaid 结清、一原子欠款仍违约、无人认购可自行取消、两人取消），原有用例按新规则更新。
3. **披露与工具**：`FINANCE_POLICY`（`agentbl-cash-rights-v4`）写明新规则；`prepare-rights-candidate.mjs` 先部署实例自己的治理，`n5-deployment.mjs` 让 Hub 登记走 Hub 的治理、其余 12 项走新治理。

待用户执行（公共链交易，需要明确授权、干净提交与同提交 CI 收据）：部署并激活 v4 实例（`npm run testnet -- prepare <新实例ID> --execute`，延时后 `activate`），资金路径验证，之后同时切换 `public/rights-instance.json` 与 `public/application-config.json`。在此之前公共测试网上的 v3 实例在应用内只读并只保留退出。

## 仍保留的已知限制

| 问题 | 影响 | 应用层现状 |
| --- | --- | --- |
| 部分募集需要单独的 `finalizeFunding` 才能放款 | 遗漏时只能在放款截止后退回本金 | 工作台提供“关闭已达最低额的募集”，“需要处理的事项”列出待关闭的池 |
| 来源审查（≤24 小时）是全局开关 | 漏刷新一次，所有池同时停止认购与放款 | “需要处理的事项”指明由资格审查方刷新；列表显示 `screening_expired` |
| 估值最长 30 天且不能续期 | 认购与放款必须在估值期内完成 | 详情显示估值有效期；过期池列入“需要处理的事项”，需按新条款另行发行 |
| `clearRiskLock` 要求全部份额已销毁 | 任一出资人不领取，单证风险锁无法解除 | 无；可研究把未领现金权利与已处置单证的风险锁分开，但不能抹掉迟领权利 |
| 退款不减少 `subscribed`；`Repriced` 状态从不设置 | 已取消池显示历史认购份数；死状态 | 页面把已全部退款的池显示为 0 份并注明已退款 |
| 两个大合约距 EIP-170 上限约 210 字节 | 下一版本难以继续追加逻辑 | 需先拆分模块或库 |
