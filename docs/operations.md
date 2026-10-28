# 运行与维护

范围是离线 Demo 和 Injective EVM 测试网研究应用。人工钱包验收已在 v2 实例完成，当前 v3 实例尚未重新验收，见[人工验收](acceptance.md)；真实手机、独立主机/签名权接管及商用部署不再列为后续交付任务。

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
| `AGENTBL_ALLOWED_HOSTS` | 除 localhost/127.0.0.1 外允许的主机名；经回环到达但 Host 不在名单内的请求返回 421（防 DNS 重绑定）。Compose 默认 `localhost,127.0.0.1`，反向代理提供公网域名时加入该域名 |

合资格钱包连接 Live 后按角色工作台操作。管理员登记身份，链上角色另行核对；参与者逐次确认钱包请求。材料创建、完整条款绑定、双审、发布和交易准备均检查当前版本与权限。测试代币与 gas 由实际研究账户准备，不要把私钥放入公开 JSON。

## 当前本机服务

| 服务 | 地址 | 持久状态 |
| --- | --- | --- |
| 旧 v2 退出 | <http://127.0.0.1:3000/#/finance> | `data/runtime/n5-deployment/n5-v2-20261019/application/` |
| 旧 v1 退出 | <http://127.0.0.1:3001/#/finance> | `data/runtime/w5-app/` |

以上地址指已经初始化的本机容器；新 checkout 不会自动具有其私有材料和运行状态。各实例分别保留配置、vault 和账本，不能互相覆盖。当前 v3 实例的运行目录是 `data/runtime/n5-deployment/n5-v3-20261027/application/`，`AGENTBL_RIGHTS_CONFIG` 指向同目录上一级的 `rights-instance.json`；启动它时使用新端口，不能复用 v2 的运行目录。旧 v1、v2 不在应用内开放新增风险；用当前代码服务 v2 时，它按冻结产物核验并自动进入只退出状态。

`GET /api/health` 检查进程存活，`GET /api/ready` 检查就绪，`GET /api/ops/status` 提供运行状态。就绪并不表示真实业务启用。

研究案例目录在内存中缓存，超过 `AGENTBL_CATALOG_TTL_MS`（默认 60 秒）后在后台重建，请求不等待冷启动的公开数据源。Demo 资金池只在首次请求时建立；状态仍跟随报价的池（未被 Agent 动作接管）至多每 `AGENTBL_POOL_REQUOTE_MS`（默认 60 秒）按当前数据重新定价，所以启动时因数据源慢而暂停的案例会在数据恢复后自动重新开放，实时数据也不会悄悄过期。

## 受控实例的日常条件

受控合约对每笔认购和放款都检查实例级条件：来源审查（`refreshScreening`，最长 24 小时）、该池估值有效期（最长 30 天，不能续期）、估值人权限、单证状态、结算资产许可和进件开关。任一条件不满足，所有人都无法认购或放款。资金池列表的 `subscription_blockers` 与页面上的“不接受认购”原因来自这些链上读数；合规角色需按期刷新来源审查，估值过期后只能等放款截止后由 `startExit` 退回本金。

部分募集（最低募集额小于满额）在募集截止后需要先执行“关闭已达最低额的募集”（`finalize_funding`，链上任何人可调用）才能放款；零认购且已过募集截止的池需运营方“取消无人认购的发行”（`cancel_offering`）才释放质押单证。两者都在角色工作台中，按普通交易计划预检和钱包确认。

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

`data/runtime/` 保存材料、资金历史、原交易和恢复检查点，不属于开发垃圾。其中 `rights/public-disclosures/` 是已批准条款的公开副本，不含私有材料；要让其他实例或新 checkout 显示这些条款，可复制到 `data/disclosures/` 并提交。备份前停止所有相关写入者；备份实例父目录时，还要检查应用子目录租约及 `owner-cli` 锁。

```sh
npm run runtime:backup -- create --directory <已停止目录> --key-file <独立密钥文件> --output <新加密包> --configuration <实例JSON> --revision <源码版本>
npm run runtime:backup -- restore --directory <新目标目录> --key-file <独立密钥文件> --input <加密包>
```

恢复使用新目录，核对材料、配置、历史与余额后才接入服务。备份解密、材料解密和交易签名密钥分别保管；不复制密钥到 Git、产物包或日志。旧 v1 专用恢复演练器已移除，日常恢复使用上述通用备份工具。

## 测试与维护入口

已批准条款的公开副本可用 `npm run disclosures:import -- <实例 deployment-state.json 或 public-evidence/*.json>` 导入 `data/disclosures/`：只复制能重算出自身哈希、且与配置实例链上 `termsHash` 和披露哈希一致的条款包（默认实例为 `public/rights-instance.json`，可用 `--config` 指定，`--dry-run` 只核对）。

日常检查使用 README 的命令表。`test:capital`、`test:rights`、`test:evidence`、`test:operations` 和 `test:finance` 共享一个集成入口，在隔离的本地 EVM 执行，不读取公共测试网资金。

`npm run install:release` 是全新安装入口：按锁文件安装应用与合约依赖并禁用第三方安装脚本，再显式执行项目内已审查的 Hardhat Zod 兼容补丁（`hardhat/scripts/patch-zod-compat.mjs`，普通安装时是它的 postinstall）并用一个非法配置核对诊断。`verify:release`、`build:clean` 和 CI 的 “Fresh release install” job 都走这个入口，从空依赖目录开始。

`npm run verify:release` 在临时新 checkout 用上述入口安装锁定依赖，执行应用/合约/集成/浏览器检查、审计、两次构建和隔离容器验证。只继承必要运行环境，不复制 `.env`、材料或原签名密钥。普通 Node 套件中跳过的 EVM 场景由对应集成入口实际运行；跳过不计通过。

`npm run build:clean` 比较两次干净构建；`npm run test:load -- --soak-seconds 600 --output test-results/load.json` 测量现有离线服务，不代表公共 RPC 或并发商业容量。

测试网工具 `npm run testnet -- status n5-v3-20261027`（旧实例为 `n5-v2-20261019`）只查询原部署记录。`prepare` / `activate` / `funding` 需要 `--execute` 和相同提交 CI 收据，未知交易先找原 nonce/hash，不能自动重发；历史已结清样例不应重新广播。`npm run testnet:legacy -- status` 仅查询旧部署。

人工验收的新池由 `npm run testnet -- acceptance n5-v3-20261027 <阶段>` 准备，输入为实例目录中的 `acceptance-input.json`：批次名、两个验收钱包、两个池的认购截止，以及可选的审查截止。各阶段如下：

- `plan` 不读密钥，列出每个阶段将发送的交易及其原交易状态。
- `prepare` 建立正常兑付池和失败募集池，登记出资身份，并发放资格、测试代币和 gas。执行前先停止该实例应用；执行期间持有运行租约，独占写材料 vault。
- `screening` 刷新审查，有效期不超过 24 小时。
- `repay` 在两个钱包认购满额后放款、回款并结清。

签名阶段与 `funding` 相同，需要 `--execute` 和同提交 CI 收据。认购、领取和退款只由验收者自己的钱包完成。

x402 付款取回只在 Live 生效。用户在报告页“付款记录与找回”中用付款钱包签署取回请求，或导出不含签名的付款记录供人工核对；运营方核对时以服务端 `x402` 回执历史和链上交易为准，不要求用户提供签名。

运行告警写入对应 runtime 的 `ops-alerts.jsonl`。来源审查是全实例窗口（最长 24 小时），剩余不足 `AGENTBL_SCREENING_WARN_SECONDS`（默认 4 小时）或已过期时发出 `warning` 告警，写明由 `compliance` 角色执行 `refresh_screening`；它不改变服务就绪状态（过期时链上自会拒绝新认购和放款）。估值最长 30 天且不能续期，由各池的 `valuation_expired` 认购阻断原因显示，属于合约约束。可选 webhook 由操作者配置；自动 HTTP 接收测试不表示真实值班人员已经确认。日常维护保留上述能力，但不新增交付门槛。

执行产物使用忽略的 `artifacts/` 或 `test-results/`，不再建立阶段计划、日报、评审报告树。当前文档只维护 README、架构、合约、数据来源、运行说明与人工验收。
