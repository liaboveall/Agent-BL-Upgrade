# Phase 7：决策锚定

WP7.1 已实现独立的 `AgentDecisionLog`、终态归档、批量 Merkle 证明、HTTP/CLI 校验和中英决策详情。2026-10-15 用户明确授权后，已在 Injective EVM Testnet 1439 完成部署、注册审阅版本及授权既有专用 pricing 地址共 3 笔交易，逐笔核验通过。启用后台锚定和首次批次仍须按 [实现规划 §16](agent-implementation-plan.md#16-需要用户亲自完成或确认的事项) 单独确认。7.2–7.5 仍是原计划明确暂不做的可选项。

## 承诺内容与版本

`COMPLETED / FAILED / REJECTED / SKIPPED / OBSERVE_ONLY` 在决策日志持久化后立即定稿。`SKIPPED` 也覆盖审批过期，审批中的记录没有定稿序号。叶子包含 schema、Demo/Live、序号、决策/事件/案例/池 ID、动作、终态、策略结论、审批结果/身份/方式/时间/期限、执行引用/交易、证据哈希、报价哈希、Agent 版本和定稿时间。字段来自公开脱敏投影，不包含原始单证、提示词、审批备注或密钥。

叶子为 `keccak256(0x00 || UTF8(canonical JSON))`：对象递归排序，数组保序。内部节点为两个 bytes32 按值排序后拼接的 Keccak，奇数尾节点直接提升；每批最多 256 条，证明最多 8 层。固定叶子结构和前缀区分叶子与内部节点前像；JS 生成的证明由真实本地 Solidity 合约交叉验证。排序节点的背景说明见 [OpenZeppelin MerkleProof](https://docs.openzeppelin.com/contracts/5.x/api/utils/cryptography#MerkleProof)。

版本包含 `policy_hash / code_commit / model_id`，规范 JSON 的 Keccak 为 `version_id`。`code_commit` 是实际进程加载的 `src/**/*.js`、package.json 和 lockfile 的规范源文件 SHA-256 承诺，**不是**声称 dirty 文件等同于某个 Git commit；LF/CRLF 统一。策略哈希包含运行配置，排除锚定开关、间隔和最小批量；更改自主级别会生成新版本。`model_id` 标记配置模型，实际模型调用仍以决策用量记录为准。

新版本只能由 owner 注册，服务器不能注册自己；跨版本队列在版本边界切批。旧决策没有历史版本证据时明确标为 `UNRECORDED_LEGACY`，不追认成当前代码产生的结果。重启后的未决方案保留创建时版本。

## 存储、批处理与恢复

`AGENTBL_RUNTIME_DIR/agent-anchors.json` 保存每个模式独立的连续序号、不可覆盖的定稿投影和批次。原子写入失败不消耗序号。文件有独占写进程锁；同机旧 PID 被确认退出后才能接管。锁内容不可信、异机锁或仍存活的 PID 要求运维核对。

归档失败不会把已经确认的贸易执行改写成失败。定时任务和运行时 tick 会先重扫日志，成功归档后才允许原决策/审批进行保留清理。紧凑证明档案独立保留，原日志过期后 API 标明 `archived:true`，不再声称比对了已清理的原日志。备份需要包含该档案。Demo reset 只清除 Demo 档案，不修改 Live 序号。

| 变量 | 默认 | 行为 |
|---|---|---|
| `AGENT_ANCHOR_ENABLED` | `false` | 控制 Live 广播；关闭时仍归档并生成本地证明 |
| `AGENT_ANCHOR_INTERVAL_SEC` | `3600` | 相邻批次生成的最小间隔，1–86400 秒 |
| `AGENT_ANCHOR_MIN_BATCH` | `1` | 新队列最小条数，1–256；跨版本时先完成前一段 |

独立任务至多每 15 秒收集/对账一次；新批次仍遵守上述间隔。Demo 只生成 `DEMO`，Live 未启用时生成 `LOCAL`。本阶段验证不修改真实运行目录或启用真实广播。

Live 只用已配置部署、已登记版本和已授权的专用 `PRICING_UPDATER`，没有 owner key 回退或新增密钥；与定价共享签名串行队列。广播前核对真实 chainId=1439、合约代码、版本元数据、角色、链上连续序号，静态预检并再次核对模式/世代。

先持久化 `BROADCASTING` 意图，再发送；收到哈希立即持久化 `SUBMITTED`，再等待回执。未知广播在重启后仅按原哈希或精确批次事件只读恢复，绝不自动重发。扫描超过 50000 区块或出现冲突需人工对账。错误 calldata/发送者/目标/value/chainId、缺失事件、批次不符、确认不足或重组均不能成为通过的链上证明。

## API、命令与界面

公开只读接口为 `GET /api/agent/decisions/:id/anchor`。未知 ID=404；未定稿返回 `available:false`；定稿后返回 payload、叶子、版本、序号、批次、包含路径和逐项校验。状态为 `NOT_FINALIZED / PENDING_BATCH / DEMO / LOCAL / BROADCASTING / SUBMITTED / ANCHORED`。`ANCHORED` 是持久状态，只有本次重读链上证据成功才返回 `PASS_CHAIN`；RPC 不可用显示 `CHAIN_UNAVAILABLE`，不沿用缓存成功。

```text
npm run agent:verify-anchor -- --decision <id>
npm run agent:verify-anchor -- --decision <id> --file <anchor-journal> --decision-file <audit-journal>
npm run agent:anchor-plan -- --out <new-plan.json>
```

校验命令不加载 `.env`、钱包或密钥，从归档和公开审计投影重算，失败退出非零。Demo/未上链仅为 `PASS_LOCAL`；已确认 Live 批次再通过 chain-config 的 provider 查规范区块、回执、批次和包含证明。`--chain-config` 可显式指定注册表，证明对象不能指定 RPC 或合约。

计划命令不发请求、不写运行时。`--file` 读取指定归档，`--version-file` 可读取当前服务器 `/api/agent/status` 的 `anchoring.version` 对象，避免与服务配置不一致。未指定时仅用进程环境和默认配置，不读取 `.env`。当前状态元数据是公开承诺，不包含配置秘密。

详情页显示定稿时间、序号、批次与根，可展开完整证明并重验。仅当前 `PASS_CHAIN` 且有真实确认哈希时提供 Explorer 链接。Demo 明示只在本地，窄屏可换行，重验保留键盘焦点。

## 独立合约与部署

`hardhat/contracts/AgentDecisionLog.sol` 继承原有 `Owned`，原有六份协议合约及地址不变；新合约没有转账、代币或池控制权限。

| 方法 | 权限与约束 |
|---|---|
| `registerAgentVersion(bytes32,bytes32,bytes32,string)` | owner；非空承诺/模型；版本不可覆盖 |
| `setAnchorer(address,bool)` | owner；显式授权/撤销，owner 无隐式锚定权限 |
| `anchorBatch(root,fromSeq,toSeq,count,versionId)` | anchorer；已注册版本；fromSeq=上批 toSeq+1；精确 count≤256 |
| `verifyInclusion(batchId,leaf,proof)` | 公开 view；不存在的批次/过长证明返回 false |

入口是 `npm --prefix hardhat run deploy:agent-log`，**默认只打印计划，零广播**。实际部署必须先取得用户授权，再由本机操作者指定审阅过的 `AGENT_ANCHOR_DEPLOY_PLAN` 文件，并仅对该次命令设置 `AGENT_ANCHOR_DEPLOY_CONFIRM=true`。交易数为 1 次部署 + 每版本 1 次注册 + 1 次授权；单版本共 3 笔，历史未知版本可能增加注册数。没有固定 gas 费用承诺。

脚本只接受 Injective 测试网，使用已有 owner，锚定地址从现有专用 pricing key 派生。逐笔保存 owner journal 并验证规范回执及精确交易。全部初始化确认后才合并新地址/ABI/部署记录，保留其他网络及原条目；配置被并发修改时拒绝覆盖。`verify:bytecode` 原本遍历注册表，新配置自动纳入核对。部署此功能不要运行 `deploy:all`。

若广播没返回哈希，保留 journal，按记录的发送者、nonce 和 calldata 查找唯一交易并确认后恢复该哈希；不要删除 checkpoint 或重新部署。代码/策略版本变化后应单独审阅并注册新版本，不修改旧版本。部署不会开启后台广播；启用 `AGENT_ANCHOR_ENABLED=true` 和首次批次也需要明确授权。

## 真实部署与初始化（2026-10-15 UTC）

合约：[`0x6AC3bDDbBc5ab082b7c0dF0C78C2d377578BE6Ec`](https://testnet.blockscout.injective.network/address/0x6AC3bDDbBc5ab082b7c0dF0C78C2d377578BE6Ec)。以下三笔交易已由执行脚本和独立公开 RPC 复核发送者、目标、nonce、精确 calldata、value、chainId、规范回执、事件和最终状态。

| 步骤 | 交易 | 区块 |
|---|---|---|
| deploy AgentDecisionLog | [`0x27208e6af3ec24c543d5566ea215fea725d0093bb6f36a6fd5b0849bbdc4ac3b`](https://testnet.blockscout.injective.network/tx/0x27208e6af3ec24c543d5566ea215fea725d0093bb6f36a6fd5b0849bbdc4ac3b) | 143820823 |
| registerAgentVersion | [`0xaad5df123c763ec5443efd121d123e7075c57c9cdeee90c85c56eb2b70ed663f`](https://testnet.blockscout.injective.network/tx/0xaad5df123c763ec5443efd121d123e7075c57c9cdeee90c85c56eb2b70ed663f) | 143820831 |
| setAnchorer | [`0xe20002c73f75e67dc30f0e50ee759cba1ed9162f84514818292f0a187ecabd97`](https://testnet.blockscout.injective.network/tx/0xe20002c73f75e67dc30f0e50ee759cba1ed9162f84514818292f0a187ecabd97) | 143820839 |

登记版本为 `0xa365b230c8fec402b51d3291f3cd1623da1f93acc674515d471171be0558d49a`，使用已审阅计划的默认策略和模型 `x-test-2`。实际运行服务器启用前仍须比较其公开 `anchoring.version`；本次未登记其他策略或遗留未知版本。owner 为 `0x9da22292D85e2A584ace6bb347D7054486b5ed6B`，显式 anchorer 为 `0xEB43623667f1Add616D0FbdEBbbE067a0F195F79`；owner 未隐式获得 anchorer 权限。

部署后的 7 份注册合约字节码均精确匹配本地工件；原六个条目的地址、ABI、部署记录及其他网络逐项未变，8 份受保护 Solidity 源文件未变。pool #2 仍为 Repriced（6）/ 0.7910。`batchCount=0`、`lastSeq=0`，后台开关保持 false，首次批次没有执行。完整证据见 [只读实链核验](evidence/phase7-live-deployment-verification.json)、[独立复核](evidence/phase7-live-independent-review.json) 和 [字节码](evidence/phase7-live-bytecode.json)。

owner 余额实际减少 **0.000248193865 INJ**，逐笔历史余额验证其等于 `gasLimit × maxFeePerGas` 合计。回执 `gasUsed × effectiveGasPrice` 合计为 **0.00020450820091012 INJ**，两个数值分别记录，未推断网络退款机制。

前两次命令均零广播：第一次 WSL 的 Hardhat 包装器选择 Windows Node，临时确认变量未传入，返回 dry-run；第二次 Linux Node 缺少 EDR 平台依赖，在脚本前停止。第三次使用现有 Windows Node，并通过 WSLENV 显式传入计划路径和确认变量（先验证计划 SHA-256 一致），成功发送恰好 3 笔。没有安装或改写依赖。

WSL 使用 Windows 安装的 Hardhat 时，先用无害检查确认计划文件可读、确认变量存在及计划 SHA-256；跨 Windows 进程需在 WSLENV 追加 `AGENT_ANCHOR_DEPLOY_PLAN/p:AGENT_ANCHOR_DEPLOY_CONFIRM`。Linux 原生安装可直接使用 Linux Node，但必须具备对应 EDR 平台依赖。保留所有尝试日志，出现未知广播时仍按原 checkpoint 对账。

## 验证与局限

Node 覆盖规范叶子、审批、1/奇数/256 条树、版本切批、并发定稿、真实第二 OS 进程锁、死进程恢复、写失败、未知广播、模式切换、RPC/回执/事件/规范区块、保留、HTTP 和 CLI 篡改失败。Hardhat 覆盖新合约、JS→Solidity 证明、部署初始化/合并/重跑/字节码。中英与 1440/390px 浏览器验证覆盖实际界面。

preflight 扩为 **71 项**。完整当前结果、工具限制、源文件清单和失败历史见 [phase7-completion.json](evidence/phase7-completion.json)。本地假链/合约测试不代表 Injective 部署、真实模型或人工/实体设备验收。本地根可以连同档案一起被改写；只有确认上链后才可供第三方检测后续篡改。连续序号防止已提交批次跳号，不证明定稿前没有隐瞒事件，也不证明输入事实或审批身份经过外部认证。

建议提交分组（本轮未提交、未推送）：① 独立合约与默认 dry-run 的部署/恢复工具；② 终态归档、版本、批处理与 API/CLI；③ 中英详情与焦点修复；④ 回归、发布闸门、文档和验收证据。先前阶段 dirty 改动应按原功能保留分组。

Phase 7 独立只读复核发现的模型空值/空格规范化和 UTF-8 长度边界均已修复：版本与实际请求共用默认模型语义，部署计划按合约的 128 字节上限在任何广播前拒绝超限输入。

生产镜像现同时复制 package.json 和 package-lock.json，供运行时版本承诺使用。已用 Node 22.23.3 容器在 `--network none --read-only` 下启动和停止 Agent，验证版本计算及默认关闭的广播状态；没有发布镜像或部署服务。

最终本地验收：1222/1222 Node、86 项本地合约测试、20/20 确定性质量闸门、296 项中英/1440/390px 浏览器检查；preflight 66 PASS / 0 WARN / 5 Live SKIP / 0 FAIL（71 项）；覆盖率行/分支/函数 94.47% / 85.03% / 92.42%。禁网、只读 Node 22.23.3 容器启动和 Windows HTTP 200 通过；独立复核两项 P2 已修复并复核闭合。完整清单见 [phase7-completion.json](evidence/phase7-completion.json)。部署前 465 项源文件逐项复核无变化，原有协议/配置 9 项哈希未变；授权部署后该清单仅 chain-config 新增条目及字节码验证测试的新增合约夹具发生变化，376 个既有 dirty 路径保留；临时服务器和验证容器已停止。原测试报告及失败历史均保留，未提交、未推送。
