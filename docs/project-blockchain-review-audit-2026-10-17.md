# Qoder 区块链评估报告复核（2026-10-17）

复核对象：[原报告](project-blockchain-review-2026-10-17.md)，402 行。当前基线为 `cc09644fb652d5a995342a083362e7b95e8dd8b1`，不是此前 Phase 7 的旧交付版本。工作区有既有图片、前端、测试及未跟踪文件；本次保留原状，仅新增复核文档与证据。被审报告与已核对源码的 SHA-256 见 [审查快照](evidence/blockchain-review-audit-2026-10-17/snapshot.json)。

**总体判断：报告在 RWA 业务闭环、链上实际保证和信任边界方面较全面，而且有技术洞察；主要结论值得采纳。但跨层验证、发现的可复现性、风险分级和整改方案仍不够严密，不能据此宣称已经完成全面深入的区块链安全审计。**

它最有价值的判断是：当前实现主要提供受角色控制的状态机、份额凭证与审计记录，尚未提供资金托管、投资者兑付和可执行的抵押处置。这符合当前合约及 README 已声明的边界。报告没有把测试通过直接等同于融资闭环成立，这一点正确。

不过，报告对“金融系统必须把哪些环节放在链上”的措辞过于绝对。若未来选择受监管托管人、银行账户和链下法律执行，也需要按那套信任模型审查资金对账与投资者权利；不能仅凭缺少链上 escrow 就推导所有现实金融安排都无效。对当前项目，能够确认的是这些替代安排也尚未在本次材料中得到验收证明。

**覆盖质量**

| 维度 | 复核判断 | 依据与不足 |
|---|---|---|
| 应用目的、业务主线、Demo / 浏览器实验 / v3 区分 | 较好 | 识别了三条不同路径，避免把演示交易等同于真实贸易融资 |
| 资金与投资者权益 | 较好 | 指出了没有付款、兑付、退款；但将产品能力缺失与漏洞混用同一 P0 分级 |
| eBL 登记、唯一性、质押、处置 | 较好但不完整 | 抓住只能锁不能处置；还缺真实签发者、持有人同意、登记版本与已违约资产再次融资的完整权利模型 |
| 合约状态与权限 | 有深度但不穷尽 | Liquidation 无出口确实存在；Frozen 的适用条件和其他卡死组合没有完整展开 |
| 合约、Agent、CLI、前端的一致性 | 不足 | 遗漏了违约后补录证明被拒、多笔补款不能经当前审批结算、报价期限未写入链上等问题 |
| 定价、Oracle 和金融不变量 | 部分覆盖 | 识别了链下护栏可以被角色绕开；未充分区分重复提交、时效、执行顺序、估值可信度和期限一致性 |
| x402、签名与付款恢复 | 部分覆盖 | 指出了受信 facilitator / attestor；未给出签名域、授权期限、nonce、未知广播及付款后交付失败的系统验证矩阵 |
| 部署、迁移和链上证据 | 部分覆盖 | 有数值快照，但缺提交/文件摘要、固定区块、RPC 脚本输出、构建产物与部署字节码的绑定 |
| 决策承诺、隐私和数据可用性 | 方向正确 | 正确区分包含证明与完整性；但不能把 pricing 的普通 JSON 哈希概括成全项目都没有 canonical 序列化 |
| 验证方法与验收条件 | 不足 | 测试数量有披露；缺逐项反例、威胁前提、失败日志、影响范围和可执行关闭条件 |

**独立核对支持的关键判断**

- `subscribe` 不转移认购资产。陌生本地测试账户可以认购全部 100 份，交易 `value=0`，事件仍报告 `paidAmount=80000000`，状态变为 Funded。这里的“免费”指不支付认购资金，仍需支付 gas。当前测试网 v3 无池；这是未来开池后的可执行路径，不代表现在已经发生抢份额或资金损失。
- Liquidation 在现有合约接口下没有退出路径。复核对取消、违约、损失结清、付款、到港、清偿、暂停、恢复、冻结、调价、owner 解押、holder 转移共 12 条操作检查，均失败，质押仍在。
- 无认购者的 Frozen 池确实不能取消或违约解押。到期后仍可认购也得到本地复现。
- owner/updater 可以越过链下策略直接调用合约；没有付款和到港真实性的链上自主核验。单一管理员信任模型的描述成立。
- `docs/contracts.md` 的状态、Defaulted 和 owner 解押说明确有 v2 残留；不是仅凭文档标题推测。

完整反例：[本地 EVM 脚本](evidence/blockchain-review-audit-2026-10-17/local-contract-probes.mjs)、[8 项观察结果](evidence/blockchain-review-audit-2026-10-17/local-contract-probes.json)。这些反例断言确认的是当前问题存在，并非修复通过。

**报告遗漏的具体问题与边界**

1. **违约后的证明录入在合约和链下规则中不一致。** `RWAOfferingPool._requireSettleable`（506–508 行）允许 Defaulted，实际本地合约可以在 Defaulted 后录入付款、补款、到港并最终 Repaid。但 `poolRules.js`（56–64 行）的 RECORD_PAYMENT / RECORD_ARRIVAL 只接受活跃状态，Defaulted 被返回 `illegal_transition`；`buildSettlementPlan`（121–122 行）使用这套规则。因此经现有审批路径办理迟到付款或到港，会被链下阻止。问题是跨层功能未接通，不能表述为合约本身不支持违约后回收。

2. **多笔回款的合约累计金额与结算验证模型不一致。** 合约 `recordAdditionalPayment`（362–370 行）把多笔金额累加，但 `settlementPipeline.js`（125–138 行）仍以一个 `payment_proof` 交易核验整个累计数。离线回执反例中两笔转账为 0.4 和 0.6 USDC，链上记录累计 1 USDC，SETTLE 计划仍失败于 `payment_transfer_mismatch`。这不推翻其对单笔付款的安全检查，而是说明追加付款后的标准结算路径尚不完整；直接 owner 调用合约另当别论。当前 owner action 列表也没有追加付款、markDefault、settleLoss 的完整审批入口（`ownerTxPlan.js:16`）。

3. **报价期限与链上到期日未接通。** 当前原油案例 `quoteFromCase` 给出 `tenor_days=30`；`openingPlan.js`（135–150 行）只生成 mintEBLV2 / pledge / createOffering 三步，创建参数没有期限，也没有 setMaturity。合约 `createOffering`（224 行）固定设置为创建后 60 天。于是定价的年化解释与链上违约窗口可能使用不同期限。报告提到了 setMaturity 无事件，却未追到这个更直接的业务错位。还需要明确期限从装船、融资开始还是创建区块起算。

4. **Frozen 不是只有“零认购者”这一种卡死组合。** 若已足额记录回款和到港，随后 FREEZE_POOL，到期后 `outstandingDebt=0`：settle 被 Frozen 拒绝，markDefault 又要求欠款大于零，resume 只接受 Paused，最终仍无法正常结束。另一方面，Frozen 且有认购者、存在欠款、已到期时可以 markDefault；因此不能笼统说所有 Frozen 池都绝无出口。

5. **Oracle 去重不等于时效与顺序保护。** 已使用的同一参数组合会被拒绝，这是现有实现的真实优点；但一份较早准备、此前未提交的 OPEN 报价，仍可在较新的降价之后执行。反例先执行 700000，再提交预先准备的 900000 报价，最终接受旧报价；同一旧报价再次提交才被拒。执行需要 updater 授权，不是任意地址攻击。合约尚未要求 expected quoteVersion、有效期或单调序列；`quote_hash` 的计算字段（`pricingEngine.js:484`）也没有覆盖 tenor、到期日和估值有效期。应单列“过期/乱序更新”审查，不能仅以“有 replay guard”结束分析。

前 1–3 项使用真实 JS 函数与合成 provider 回执复现，见 [跨层脚本](evidence/blockchain-review-audit-2026-10-17/cross-layer-probes.mjs)、[4 项观察结果](evidence/blockchain-review-audit-2026-10-17/cross-layer-probes.json)；第 4–5 项在本地真实 Solidity 合约上复现。都没有向测试网发送交易。

**需要纠正或收窄的原报告表述**

| 原报告位置 | 问题 | 更准确的说法 |
|---|---|---|
| 291 行“没有 fuzzing” | 忽略了现有固定种子随机模型；与报告 146 行承认随机序列也不一致 | 已有轻量随机状态序列测试：6 个种子、每个 300 步；缺少对活性、v3 新状态和偿付闭环的充分属性验证，未执行形式化证明 |
| 291 行“未覆盖免费认购/合规默认值” | 与已有测试直接冲突 | `contractHardening.test.js:232` 明确测试不收认购资金，`contracts.test.js:99` 明确测试默认 Permissionless；这些行为是按演示范围写入测试，没有被设为生产拒绝条件 |
| 四组 P0 | 混合产品缺口、显式信任模型、治理建议、需要角色的攻击和真实状态死锁 | 分开列“真实资金部署阻断项”“当前可复现缺陷”“受信角色能力”“后续产品选择”；再按前提和影响定严重性 |
| 261 行建议“增加角色撤销” | 现有 executor/updater/attestor/anchorer 的 setter 已接受 `false` | 应审查撤权速度、应急演练、旧钥残留、角色清单和变更事件；不应暗示完全没有撤权 API |
| 271 行从“没有个人成本存储”推到“不能直接计算个体权益” | 成本基础与按份额分配权并非同一件事 | RWAToken 有个人余额及总供给；等权按比例回收可以据此计算。成本、退款、多批价格和税务需要额外账，但缺成本不必然使按份额兑付不可实现 |
| 273、302、344 行哈希/规范化 | 对 pricing payload 的批评成立，但范围应明确 | `decisionLogger.stableStringify`、决策 Merkle 叶子、x402 部分路径已有排序序列化；应审查各 schema 的字段完整性、算法与版本，而非假定全仓库都未规范化 |
| 275 行、346 行锚定能力 | 批次数为零表示尚未实链运行，不能等同于实现不存在 | 本地包含证明与批次能力存在；生产运行、数据持续可取回及首次实链批次分别待证明。启用前还应核对当前 code/policy 版本已获注册 |
| 277 行 KNOWN_LIVE_POOLS 遗留 | 仅看常量容易高估当前误关联风险 | 当前 v3 配置显式 `knownLivePools=[]`，factory 按新 pool 地址隔离 runtime，并取消旧 history pool #1 规则；旧常量保留为历史兼容。需要迁移说明，但不能直接当作 v3 默认会误用旧池 |

报告的状态图（104–116 行）也应改成分支图；Repaid、Defaulted、LossSettled、Cancelled 并非可以按所画顺序连续转移。图可以简化，但不能让合法交易路径变得含混。

**整改建议仍需补足的工程条件**

- 把 declaredValue 写入链上覆盖检查，只能约束某份声明，不能使该值成为可信估值。应明确估值者、估值时间、折扣、币种与精度、签名及其 chain / contract / asset 域、有效期和可撤销性；否则只是把不可信输入变成硬约束。
- “接入 PaymentOracle”不能自动解决回款真实性。当前 PaymentOracle 是 attestor 日志。普通 EVM 合约不能仅凭交易哈希读取历史 Transfer 日志；应选择同交易资金转入、独立可验证的回执/区块头证明，或明确保留受信预言机。[Solidity 0.8.24 Events 文档](https://docs.soliditylang.org/en/v0.8.24/contracts.html#events) 明确区分了日志访问和外部提供 Merkle 证明。
- “permit/签名 + 托管”仍是方向，不是完整设计。需指定实际资产支持的授权标准，并验证域、nonce、deadline、收款人和份额受益人绑定、授权被抢先使用后的恢复。如果采用 ERC-3009，标准特别讨论了 wrapper 中 transferWithAuthorization 被抢先调用的风险和 receiveWithAuthorization 的用途。[ERC-3009 安全说明](https://eips.ethereum.org/EIPS/eip-3009#security-considerations)。这属于待验证设计要求，本次没有声称发现当前授权实现的新漏洞。
- 新增资金托管后必须有资金守恒、跨池隔离、不得重复退款/领取、舍入余额、费用和坏账分配、重入与失败转账的属性测试。当前只是数量和状态的随机模型，不证明偿付能力。
- “每个人的成本都上链”“份额必须可转让或 burn”“必须使用某种特定多签/时间锁”不是单一正确答案。应先定义投资者权利、信任模型和验收条件，再选可转让份额、不可转让凭证 + claim 记录、外部托管等实现。
- 测试网 USDC 交易能证明该测试网代币和协议的技术执行，不能表述成真实美元清算、法律有效货权或机构合规证明。

因此，不建议直接按“先接资金，其他随后”的顺序实施：先确定原型/资金协议的交付范围，修正状态出口和跨层期限/回收语义，再设计资金、权利与治理方案，然后以一个池的正常、募集失败、违约、多笔回收和应急恢复路径共同验收。抵押处置和状态活性应与资金能力一起成为新资金版本的准入条件。

**本次验证与证据边界**

| 检查 | 本次结果 | 能证明的范围 |
|---|---|---|
| `npm run test:contracts` | 92/92 通过 | 本地 Hardhat 合约套件；不证明报告列出的缺口不存在 |
| 4 个相关 Node 测试文件 | 105 项通过、进程退出 0 | opening / settlement / watcher / v3 deployment 既有回归；[原始输出](evidence/blockchain-review-audit-2026-10-17/targeted-node-tests.log) |
| 自建反例 | 8 项本地合约观察 + 4 项跨层观察均确认 | 当前行为及缺陷存在，不是修复通过，也不是真实资金验收 |
| 新增 3 个调查脚本 ESLint | 通过，0 warning | 新增脚本静态检查；未重跑全仓库构建或全量 lint |
| 当前测试网只读核验 | 区块 `144160220`，7/7 部署运行字节码与本地 artifact 精确匹配 | 绑定同一固定区块；没有重做干净环境编译或编译器审计 |

只读区块哈希：`0xd2e1709eb9ba4ec86bf03a3686a5c6f12e1b463c8345275e6d52501c2a43c173`。采集时间 UTC `2026-10-17T09:58:26.915Z`，即新加坡 `2026-10-17 17:58:26`。原始输出与脚本：[live-readback.json](evidence/blockchain-review-audit-2026-10-17/live-readback.json)、[live-readback.mjs](evidence/blockchain-review-audit-2026-10-17/live-readback.mjs)。RPC 地址与链号也与 [Injective 官方网络资料](https://docs.injective.network/developers-evm/network-information)一致。

该区块读取到：协议版本 3、accessMode=0、complianceGate=0、nextPoolId=1、nextEblId=1、emergencyStopped=false、batchCount=0、lastSeq=0、PaymentOracle.attestationCount=2；六份带 owner 的合约均为同一无部署代码的地址。它支持原报告的基本快照，但 attestationCount=2 本身不证明两笔 USDC 付款有效。本次没有重新追溯这两笔付款的完整转账与交付证据。

原报告的 1311/1311 全量 Node 结果仅按其原有声明保留，本次未重跑全量 npm test、浏览器、构建、真实签名/付款、法律审查、负载或灾备恢复。单 RPC 读数也不是独立轻客户端共识证明。

调查中的失败尝试同样保留：[attempts.md](evidence/blockchain-review-audit-2026-10-17/attempts.md)。Linux Node 直接加载现有 Windows EDR 依赖失败后改用 Windows Node；随后修正了调查脚本对 ABI revert reason 的解码，没有改项目依赖或合约来让反例通过。
