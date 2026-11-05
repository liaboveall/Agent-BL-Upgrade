# 运行与维护

范围是离线 Demo 和 Injective EVM 测试网研究应用。人工钱包验收已在 v2 实例完成，当前 v4 实例（以及已冻结为只退出的 v3）尚未重新验收，见[人工验收](acceptance.md)；真实手机、独立主机/签名权接管及商用部署不再列为后续交付任务。

## 启动和配置

```sh
npm ci
npm --prefix hardhat ci
npm run compile:contracts
npm run dev
```

`dev` 构建前端后启动 API；`npm start` 使用已有 `dist/`。环境变量以 [.env.example](../.env.example) 为准，真实值仅放本机 `.env` 或独立密钥文件。

| 配置 | 用途 |
| --- | --- |
| `HOST` / `PORT` | 本机建议 `127.0.0.1`，默认端口 3000 |
| `AGENTBL_RUNTIME_DIR` | 持久运行目录，每个实例使用独立目录 |
| `AGENTBL_RIGHTS_CONFIG` | 当前受控实例清单的绝对路径 |
| `AGENTBL_ADMIN_TOKEN` | 管理接口认证 |
| `AGENTBL_RIGHTS_KEY` | 独立材料加密密钥，不能随公开配置分发 |
| `AGENTBL_REQUIRE_EXISTING_RUNTIME` | 已初始化部署拒绝缺卷后空启动 |
| `AGENTBL_RELEASE_REVISION` | 运行版本标识 |
| `LLM_HTTP_RELAY` | 设为 `true` 才开放浏览器 LLM 中继 `POST /api/llm/chat`；默认关闭，Copilot 等服务端模型功能不受影响 |
| `AGENTBL_INTAKE_KEY` | 研究上传的独立封存密钥（32 字节十六进制）；未设置时在 `research-agent/ingest-uploads.key` 生成，只保护上传目录的单独副本 |
| `AGENT_UPLOAD_BATCH_MAX_BYTES` / `AGENT_UPLOAD_WORKSPACE_QUOTA_BYTES` / `AGENT_UPLOAD_TOTAL_QUOTA_BYTES` | 单次上传合计、每个浏览器工作区与整个上传存储的容量；默认 24 MiB、48 MiB、128 MiB。上传存储最多占一次运行备份上限（256 MiB）的一半，更大的设置按 128 MiB 处理。待复核任务的第一次纠正可再用一批上传大小的预留，所以待复核材料占满额度时纠正不被卡住；容量拒绝会写明已用量、上限、占用空间的待复核任务和下一步（提交纠正或撤回） |
| `AGENT_INGEST_MAX_JOBS` / `AGENT_INGEST_WORKSPACE_MAX_JOBS` / `AGENT_INGEST_JOB_RETENTION_DAYS` | 保留的上传任务总数、每个工作区的任务数，以及已完成且无需复核的任务保留天数；默认 500、100、30。排队、处理中和待复核的任务不会为腾出空间而删除，任务表被它们占满时新上传返回 507 `intake_jobs_full`（单个工作区为 413 `upload_job_quota_exceeded`）。配额按逻辑任务计：待复核任务与纠正它的复核版本共占一个名额，所以占满时仍可提交每个待复核任务的纠正；任务表最多保留配额的两倍，再多的复核版本返回 507 `review_capacity_exhausted` |
| `AGENTBL_BACKUP_BUDGET_INTERVAL_MS` / `AGENTBL_BACKUP_WARN_RATIO` | 运维监测按此间隔（默认 60 秒）测量运行目录相对备份上限的大小；达到该比例（默认 0.8）时向运维告警 `backup_budget_near`，超过上限时 `backup_budget_exceeded` 并暂停新的进件 |
| `AGENTBL_MAX_EVENT_WAIT_MS` | Agent 事件最长等待时间（默认 15 分钟）。最老的未完成事件超过它，或有已接收却不在任何队列里的事件时，就绪检查发出 `events_waiting` / `events_not_queued` 警告 |
| `AGENTBL_ALLOWED_HOSTS` | 除 localhost/127.0.0.1 外允许的主机名；经回环到达但 Host 不在名单内的请求返回 421（防 DNS 重绑定）。Compose 默认 `localhost,127.0.0.1`，反向代理提供公网域名时加入该域名 |

合资格钱包连接 Live 后按角色工作台操作。管理员登记身份，链上角色另行核对；参与者逐次确认钱包请求。材料创建、完整条款绑定、双审、发布和交易准备均检查当前版本与权限。测试代币与 gas 由实际研究账户准备，不要把私钥放入公开 JSON。

## 当前本机服务

| 服务 | 地址 | 持久状态 |
| --- | --- | --- |
| 旧 v2 退出 | <http://127.0.0.1:3000/#/finance> | `data/runtime/n5-deployment/n5-v2-20261019/application/` |
| 旧 v1 退出 | <http://127.0.0.1:3001/#/finance> | `data/runtime/w5-app/` |

以上地址指已经初始化的本机容器；新 checkout 不会自动具有其私有材料和运行状态。各实例分别保留配置、vault 和账本，不能互相覆盖。当前 v4 实例的运行目录是 `data/runtime/n5-deployment/n5-v4-20261029/application/`，`AGENTBL_RIGHTS_CONFIG` 指向同目录上一级的 `rights-instance.json`；启动它时使用新端口，不能复用 v2、v3 的运行目录（v3 的在 `n5-v3-20261027/application/`）。旧 v1、v2、v3 不在应用内开放新增风险；用当前代码服务它们时，按冻结产物核验并自动进入只退出状态。

`GET /api/health` 检查进程存活，`GET /api/ready` 检查就绪，`GET /api/ops/status` 提供运行状态。就绪并不表示真实业务启用。容器 healthcheck 只调用 `/api/health`，`healthy` 标签不代表 `/api/ready` 已就绪，更不代表融资条件满足。

未就绪时暂停所有带入新材料、新条款或新资金的入口，规则集中在 `src/ops/intakePolicy.js` 一处。按路由暂停（`NEW_INTAKE_ROUTES`）：`POST /api/agent/ingest`、旧接口 `POST /api/ebl/upload`、复核重传 `POST /api/agent/jobs/:id/review`、认购 intent 与 Demo 认购，以及 Rights 材料创建、证据创建、完整条款保存与绑定、发布和签名请求。按操作暂停：登记单证、质押、发行、同意条款和放款五类 Rights 钱包计划（`NEW_RISK_RIGHTS_OPERATIONS`）与认购（`NEW_RISK_CAPITAL_OPERATIONS`）；它们在准备草稿时检查一次，在广播检查点的读链前和提交前各再检查一次，所以就绪时保存的草稿在降级后不会再交给钱包。以上均返回 503 `operations_not_ready`。全局守卫、Rights 与受控资金路由（单独挂载时也一样）和 Agent 服务都按这一份规则检查，后续新增的别名或 MCP 调用同样被拦下（Demo 场景回放只重放仓库内样例，不受影响）。读取、领取、退款、回款与处置等退出、原交易附加与核对、钱包操作释放（含放弃未发送的草稿）保持可用。已经交给钱包的交易服务器无法收回；需要在链上强制停止新增风险时，由 GUARDIAN `setIntakeStopped(true)` 或 OPERATOR `FREEZE_POOL` 执行。

就绪检查还看业务是否停滞，而不只看失败数和队列长度：`case_access` 在案例访问记录未加载成功时失败（新进件因此暂停，除公开样例外的私有案例一律不可读，接口返回 503 `case_access_unavailable`，恢复 `ingest-case-access.json` 后重启）；`event_flow` 在出现“已接收但不在队列”的事件，或最老未完成事件超过 `AGENTBL_MAX_EVENT_WAIT_MS` 时告警（Agent 每次巡检会把这类事件重新入队）；`intake_capacity` 在逻辑任务达到配额 90% 或复核余量不足 10% 时告警，观测值含待复核任务数、复核余量和已到期待回收字节。已到期的上传任务在启动时、每次 Agent 巡检和每次新上传前回收，不依赖再有一次成功上传。`persistence` 在事件索引或上传记录的最近一次写盘失败、尚未补写时告警（`runtime_records_unsaved`，观测值分别给出 `event_index` 和 `intake_records`）；Agent 巡检会重写它们，持续告警说明运行目录的磁盘或权限仍有问题。开始处理时写盘失败的事件不再停在“处理中”：它回到已接收，计入 `events_not_queued`，由巡检重新交出。`GET /api/ops/metrics` 另外导出 `agentbl_events_orphaned`、`agentbl_event_oldest_pending_ms`、`agentbl_unsaved_records{store=...}`、`agentbl_intake_held_jobs`、`agentbl_intake_review_headroom_jobs` 与 `agentbl_intake_reclaimable_bytes`。待复核任务占满容量时，所有者可在上传卡片上提交纠正，或撤回不再需要的任务（`POST /api/agent/jobs/:id/withdraw`，立即释放原始文件，记录与决策证据保留）；撤回不受进件暂停影响。

研究案例目录在内存中缓存，超过 `AGENTBL_CATALOG_TTL_MS`（默认 60 秒）后在后台重建，请求不等待冷启动的公开数据源。Demo 资金池只在首次请求时建立；状态仍跟随报价的池（未被 Agent 动作接管）至多每 `AGENTBL_POOL_REQUOTE_MS`（默认 60 秒）按当前数据重新定价，所以启动时因数据源慢而暂停的案例会在数据恢复后自动重新开放，实时数据也不会悄悄过期。

## 受控实例的日常条件

受控合约对每笔认购和放款都检查实例级条件：来源审查（`refreshScreening`，最长 24 小时）、该池估值有效期（最长 30 天，不能续期）、估值人权限、单证状态、结算资产许可和进件开关。任一条件不满足，所有人都无法认购或放款。资金池列表的 `subscription_blockers` 与页面上的“不接受认购”原因来自这些链上读数；合规角色需按期刷新来源审查，估值过期后只能等放款截止后由 `startExit` 退回本金。

部分募集（最低募集额小于满额）在募集截止后需要先执行“关闭已达最低额的募集”（`finalize_funding`，链上任何人可调用）才能放款；零认购且已过募集截止的池在 v3 需运营方“取消无人认购的发行”（`cancel_offering`），v4 起任何参与方也可“发起退出”（`start_exit`）取消发行并释放单证（冻结中的除外）。v4 到期时现金已覆盖全部兑付的池，`start_exit` 按已结清关闭，不进入违约。这些操作都在角色工作台中，按普通交易计划预检和钱包确认；融资页“需要处理的事项”按原因汇总本页资金池，并给出负责角色和下一步。

## 容器与安全停止

```sh
docker compose up --build -d
docker compose stop
```

Compose 默认使用自己的命名卷；已有部署应继续使用其原挂载、配置和密钥，不能用默认 Compose 覆盖。新测试实例使用不同端口和运行目录。

应用为在途公共读取预留最多 180 秒排空，Compose 的 `stop_grace_period` 为 210 秒；直接启动容器时使用 `--stop-timeout 210`，显式停止使用：

```sh
docker stop -t 210 <容器>
```

确认进程退出并释放 `.runtime-lease` 后再备份或启动另一个写入者。被强制终止的旧进程可能留下锁：先证明原持有者停止且不存在同卷写入者，保存 owner 记录后再按记录处理；不要递归删除未知锁。旧镜像不因新文档或源码整理自动获得新关闭逻辑。

## 开发文件清理

停止本地开发服务和测试后，运行 `npm run clean -- --dry-run` 查看清单，运行 `npm run clean` 清除前端构建、合约编译缓存、测试报告、覆盖率、浏览器调试产物及可选 vendor 构建依赖。随后用 `npm run compile:contracts` 和 `npm run build` 重建；`npm run vendor:build` 会按需安装自己的构建依赖。

清理不处理 `.env`、`data/runtime/`、`artifacts/` 或应用与合约的依赖目录。账本、原交易检查点、材料密钥和正式验收记录需要按下述备份流程维护。旧版 ABI 与部署基线仍用于原实例查询和退出；现行文档、样本、许可和回归测试保留在仓库，已移除的历史实现可从 Git 历史查阅。

## 备份与恢复

`data/runtime/` 保存材料、资金历史、原交易和恢复检查点，不属于开发垃圾。研究上传的访问记录 `research-agent/ingest-case-access.json`、清单 `research-agent/ingest-manifest.json` 与封存密钥（`AGENTBL_INTAKE_KEY` 或 `research-agent/ingest-uploads.key`）须与上传目录一起备份：清单记录该目录保存访问记录的起始时间，访问记录缺失或损坏时 intake 拒绝启动（只有升级前写下的旧运行目录会按其任务和案例补建一次），缺少密钥则无法读回已封存的原始文件。即使只恢复了偏好、丢了访问记录和清单，保存过偏好的案例也只有管理员可读，不会变成公开。其中 `rights/public-disclosures/` 是已批准条款的公开副本，不含私有材料；要让其他实例或新 checkout 显示这些条款，可复制到 `data/disclosures/` 并提交。备份前停止所有相关写入者；备份实例父目录时，还要检查应用子目录租约及 `owner-cli` 锁。

```sh
npm run runtime:backup -- create --directory <已停止目录> --key-file <独立密钥文件> --output <新加密包> --configuration <实例JSON> --revision <源码版本>
npm run runtime:backup -- restore --directory <新目标目录> --key-file <独立密钥文件> --input <加密包>
```

恢复使用新目录，核对材料、配置、历史与余额后才接入服务。备份解密、材料解密和交易签名密钥分别保管；不复制密钥到 Git、产物包或日志。旧 v1 专用恢复演练器已移除，日常恢复使用上述通用备份工具。

## 支持容量与部署约束

这些是当前研究规模下的明确约束，不是待隐藏的缺陷；超出时应改架构，而不是调大参数：

- **一个运行目录只有一个应用进程**（租约保护）。不支持多副本或横向扩容；扩容需要事务数据库与事件记录，先定义崩溃恢复不变量。
- **身份材料库整文件加解密**：每次写入重新加密整个文件，写队列上限 64、最长等待 15 秒（`rights_vault_busy`）。请求与长期记录增多会线性放大读写和内存；记录按 `src/rights/retention.js` 的期限清理，未结钱包操作永不清理。
- **跨文件没有事务**：每类记录一个提交点，补写与就绪检查负责一致性（见架构文档“提交边界与恢复”）。
- **加密只覆盖原始上传和身份材料库**；解析字段、案例、偏好、索引与访问记录是仅所有者可读的明文。Windows 主机上需要核对运行目录的 ACL，Unix 文件模式不代表 Windows 已受保护。
- **备份整体读取后封存**，单次上限 256 MiB，备份前须停止写入；整个目录先读入内存再加密，内存占用随目录大小放大，备份窗口内服务不可写。
- **浏览器工作区不是账户系统**：私有上传随浏览器 Cookie 识别，清除浏览器数据或换设备后无法取回；跨设备协作需要先设计可审计的账户归属与恢复凭据。角色交易的恢复不依赖它（按钱包与链在服务端发现）。
- **离线负载数字只描述本机隔离 Demo 读请求**（例如 2000 请求、并发 20），不能推算公网 RPC、写入或商用容量。

## 测试与维护入口

已批准条款的公开副本可用 `npm run disclosures:import -- <实例 deployment-state.json 或 public-evidence/*.json>` 导入 `data/disclosures/`：只复制能重算出自身哈希、且与配置实例链上 `termsHash` 和披露哈希一致的条款包（默认实例为 `public/rights-instance.json`，可用 `--config` 指定，`--dry-run` 只核对）。

日常检查使用 README 的命令表。`test:capital`、`test:rights`、`test:evidence`、`test:operations` 和 `test:finance` 共享一个集成入口，在隔离的本地 EVM 执行，不读取公共测试网资金。

`npm run install:release` 是全新安装入口：按锁文件安装应用与合约依赖并禁用第三方安装脚本，再显式执行项目内已审查的 Hardhat Zod 兼容补丁（`hardhat/scripts/patch-zod-compat.mjs`，普通安装时是它的 postinstall）并用一个非法配置核对诊断。`verify:release`、`build:clean` 和 CI 的 “Fresh release install” job 都走这个入口，从空依赖目录开始。

`npm run verify:release` 在临时新 checkout 用上述入口安装锁定依赖，执行应用/合约/集成/浏览器检查、审计、两次构建和隔离容器验证。只继承必要运行环境，不复制 `.env`、材料或原签名密钥。普通 Node 套件中跳过的 EVM 场景由对应集成入口实际运行；跳过不计通过。

`npm run build:clean` 比较两次干净构建；`npm run test:load -- --soak-seconds 600 --output test-results/load.json` 测量现有离线服务，不代表公共 RPC 或并发商业容量。

公开配置指向控制版本 4 实例 `n5-v4-20261029`；v3 实例 `n5-v3-20261027` 在应用中只保留退款、领取、回款与处置等退出。v4 有自己的治理，共享 Hub 的登记仍由原治理两名成员批准。v4 的损失路径验证需在 2026-10-30 06:42 UTC 之后再运行一次 `npm run testnet -- funding n5-v4-20261029 --execute`（同样需要干净提交和同提交 CI 收据）。

测试网工具 `npm run testnet -- status n5-v4-20261029`（旧实例为 `n5-v3-20261027`、`n5-v2-20261019`）只查询原部署记录。`prepare` / `activate` / `funding` 需要 `--execute` 和相同提交 CI 收据，未知交易先找原 nonce/hash，不能自动重发；历史已结清样例不应重新广播。`npm run testnet:legacy -- status` 仅查询旧部署。

人工验收的新池由 `npm run testnet -- acceptance n5-v4-20261029 <阶段>` 准备，输入为实例目录中的 `acceptance-input.json`：批次名、两个验收钱包、两个池的认购截止，以及可选的审查截止。各阶段如下：

- `plan` 不读密钥，列出每个阶段将发送的交易及其原交易状态。
- `prepare` 建立正常兑付池和失败募集池，登记出资身份，并发放资格、测试代币和 gas。执行前先停止该实例应用；执行期间持有运行租约，独占写材料 vault。
- `screening` 刷新审查，有效期不超过 24 小时。
- `repay` 在两个钱包认购满额后放款、回款并结清。

签名阶段与 `funding` 相同，需要 `--execute` 和同提交 CI 收据。认购、领取和退款只由验收者自己的钱包完成。

x402 付款取回只在 Live 生效。用户在报告页“付款记录与找回”中用付款钱包签署取回请求，或导出不含签名的付款记录供人工核对；运营方核对时以服务端 `x402` 回执历史和链上交易为准，不要求用户提供签名。

运行告警写入对应 runtime 的 `ops-alerts.jsonl`。来源审查是全实例窗口（最长 24 小时），剩余不足 `AGENTBL_SCREENING_WARN_SECONDS`（默认 4 小时）或已过期时发出 `warning` 告警，写明由 `compliance` 角色执行 `refresh_screening`；它不改变服务就绪状态（过期时链上自会拒绝新认购和放款）。签署这次审查的钱包失去 COMPLIANCE 角色时，审查期未满链上也同样拒绝全部新认购与放款：就绪检查发出 `screening_source_inactive` 警告，融资目录显示同名阻断原因，由当前持有合规角色的钱包重新执行 `refresh_screening`。估值最长 30 天且不能续期，由各池的 `valuation_expired` 认购阻断原因显示，属于合约约束。可选 webhook 由操作者配置；自动 HTTP 接收测试不表示真实值班人员已经确认。日常维护保留上述能力，但不新增交付门槛。

执行产物使用忽略的 `artifacts/` 或 `test-results/`，不再建立阶段计划、日报、评审报告树。当前文档只维护 README、架构、合约、数据来源、运行说明与人工验收。

## 2026-11-04 维护补充

运行 `npm run ops:review` 生成当前公开实例的只读维护清单，包含固定区块、总池数、可认购池数、到期筛查、空池/未放款退出与责任角色。它不加载签名、不广播交易。筛查更新不能延长已签条款的募集截止；新认购演示需要有效的新条款与新发行。操作前应重新读取状态，由相应角色通过工作台审阅并确认。

角色工作台登录后从服务端查找此钱包在当前链上的全部未完成操作；清除浏览器数据后可用“找回待处理操作”恢复。实例迁移后，旧实例的未结操作同样列出并标注“原实例”，按它自己保存的交易核对和释放；由此钱包另一个业务身份保存的操作会注明身份与组织，页面提供“切换到该身份核对”（已撤销的身份走仅退出会话）。若发现旧记录，先核对原交易，不要清空服务器计划或重发未知结果的交易。业务身份已撤销时，仅退出会话可核对、释放自己的旧角色操作，并保留原有 controlled intents 的退款与领取；它不能准备新操作、读取私有材料或增加风险。

### HTTPS 反向代理与工作区 Cookie

私有上传的访问能力保存在 `agentbl_workspace` Cookie（HttpOnly、SameSite=Strict）。应用自身是 HTTP 服务：在 HTTPS 由反向代理终止的部署中，二选一让 Cookie 带上 Secure：

- 全站只经 HTTPS 访问时设 `AGENTBL_COOKIE_SECURE=true`；
- 或声明代理 `TRUST_PROXY=1`（代理层数），并让代理用 `proxy_set_header X-Forwarded-Proto $scheme;` 覆盖该头。只有声明了代理时才读取 `X-Forwarded-Proto`，且只取受信代理那一跳写入的值；未声明代理时客户端自带的头不起作用。

部署后核验最终响应头，而不是只看配置：`curl -s -D - -o /dev/null https://<主机名>/api/agent/workspace/copies/CASE-EBL-CU-SIN-SHA | grep -i set-cookie` 应包含 `HttpOnly; SameSite=Strict; Secure`。

`npm run check:contract-budget` 在编译后检查 Pool / Controller 的已审字节预算；增长需要模块与版本迁移审查。根项目和 Hardhat 工具链的 CI 依赖审计均以 moderate 为失败阈值。

### 依赖审计：三套锁文件

仓库有三套依赖锁：根目录（应用）、`hardhat/`（合约工具链）和 `scripts/vendor/`（构建浏览器里运行的 Keplr/Leap 钱包 bundle 的工具链）。CI 的 `audit` 作业与每周定时运行三者：前两套用 `npm audit --audit-level=moderate`，第三套用 `npm run audit:vendor`（`scripts/audit-vendor.mjs`）。

第三套锁安装的包比 bundle 实际包含的多，所以按“这个包是否随 bundle 发给用户”来判断：`public/vendor/manifest.json` 的 `bundled_packages` 由 `npm run vendor:build` 从 esbuild 的 metafile 写入（`THIRD_PARTY_LICENSES.md` 也只列这些包），`verifyVendor()`（`npm run check`、`npm run vendor:check`）核对它们仍是锁里解析出的版本。规则：随 bundle 发出的包有 moderate 及以上公告 → 失败；不随 bundle 的构建工具有 high 及以上公告 → 失败；更低的只报告。公告服务不可达时审计失败，而不是通过。

暂时无法修复的公告可在 `scripts/vendor/audit-exceptions.json` 里登记：写明公告编号、原因、是否随 bundle 发出（会与清单核对）和复查日期，过期后审计重新失败；公告消失后记录会提示删除。目前只有 elliptic 的一条 low 级公告（随 `@cosmjs/crypto` 进入 bundle，但页面从不用本地密钥签名，Keplr/Leap 通过钱包的 OfflineSigner 签名）；升级 `@cosmjs/stargate` 的评估与前提写在该条记录的 `resolution` 里：它是主版本升级且在钱包路径上，需先在真实浏览器里验证 Keplr 与 Leap 的连接、签名、拒签、广播和交易查看，再 `npm run vendor:build` 并提交新的 bundle、清单与许可证表。只更新锁文件而不重建已提交的 bundle，不算完成修复；重建后 bundle 的 SHA-256 不变，才说明被更新的包不在 bundle 里。
