# 运行与维护

范围是离线 Demo 和 Injective EVM 测试网研究应用。当前交付唯一待办见[人工验收](acceptance.md)；真实手机、独立主机/签名权接管及商用部署不再列为后续交付任务。

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

合资格钱包连接 Live 后按角色工作台操作。管理员登记身份，链上角色另行核对；参与者逐次确认钱包请求。材料创建、完整条款绑定、双审、发布和交易准备均检查当前版本与权限。测试代币与 gas 由实际研究账户准备，不要把私钥放入公开 JSON。

## 当前本机服务

| 服务 | 地址 | 持久状态 |
| --- | --- | --- |
| 当前 v2 | <http://127.0.0.1:3000/#/finance> | `data/runtime/n5-deployment/n5-v2-20261019/application/` |
| 旧 v1 退出 | <http://127.0.0.1:3001/#/finance> | `data/runtime/w5-app/` |

以上地址指已经初始化的本机容器；新 checkout 不会自动具有其私有材料和运行状态。两实例分别保留配置、vault 和账本，不能互相覆盖。旧 v1 不在应用内开放新增风险。

`GET /api/health` 检查进程存活，`GET /api/ready` 检查就绪，`GET /api/ops/status` 提供运行状态。就绪并不表示真实业务启用。

## 容器与安全停止

```sh
docker compose up --build -d
docker compose stop
```

Compose 默认使用自己的命名卷；已有部署应继续使用其原挂载、配置和密钥，不能用默认 Compose 覆盖。新测试实例使用不同端口和运行目录。

当前 v2 应用为在途公共读取预留最多 180 秒排空，Compose 的 `stop_grace_period` 为 210 秒；直接启动容器时使用 `--stop-timeout 210`，显式停止使用：

```sh
docker stop -t 210 <容器>
```

确认进程退出并释放 `.runtime-lease` 后再备份或启动另一个写入者。被强制终止的旧进程可能留下锁：先证明原持有者停止且不存在同卷写入者，保存 owner 记录后再按记录处理；不要递归删除未知锁。旧镜像不因新文档或源码整理自动获得新关闭逻辑。

## 备份与恢复

`data/runtime/` 保存材料、资金历史、原交易和恢复检查点，不属于开发垃圾。备份前停止所有相关写入者；备份实例父目录时，还要检查应用子目录租约及 `owner-cli` 锁。

```sh
npm run runtime:backup -- create --directory <已停止目录> --key-file <独立密钥文件> --output <新加密包> --configuration <实例JSON> --revision <源码版本>
npm run runtime:backup -- restore --directory <新目标目录> --key-file <独立密钥文件> --input <加密包>
```

恢复使用新目录，核对材料、配置、历史与余额后才接入服务。备份解密、材料解密和交易签名密钥分别保管；不复制密钥到 Git、产物包或日志。旧 v1 专用恢复演练器已移除，日常恢复使用上述通用备份工具。

## 测试与维护入口

日常检查使用 README 的命令表。`test:capital`、`test:rights`、`test:evidence`、`test:operations` 和 `test:finance` 共享一个集成入口，在隔离的本地 EVM 执行，不读取公共测试网资金。

`npm run verify:release` 在临时新 checkout 安装锁定依赖，执行应用/合约/集成/浏览器检查、审计、两次构建和隔离容器验证。只继承必要运行环境，不复制 `.env`、材料或原签名密钥。普通 Node 套件中跳过的 EVM 场景由对应集成入口实际运行；跳过不计通过。

`npm run build:clean` 比较两次干净构建；`npm run test:load -- --soak-seconds 600 --output test-results/load.json` 测量现有离线服务，不代表公共 RPC 或并发商业容量。

测试网工具 `npm run testnet -- status n5-v2-20261019` 只查询原部署记录。`prepare` / `activate` / `funding` 需要 `--execute` 和相同提交 CI 收据，未知交易先找原 nonce/hash，不能自动重发；历史已结清样例不应重新广播。`npm run testnet:legacy -- status` 仅查询旧部署。

人工验收的新池由 `npm run testnet -- acceptance n5-v2-20261019 <阶段>` 准备，输入为实例目录中的 `acceptance-input.json`：批次名、两个验收钱包、两个池的认购截止，以及可选的审查截止。各阶段如下：

- `plan` 不读密钥，列出每个阶段将发送的交易及其原交易状态。
- `prepare` 建立正常兑付池和失败募集池，登记出资身份，并发放资格、测试代币和 gas。执行前先停止该实例应用；执行期间持有运行租约，独占写材料 vault。
- `screening` 刷新审查，有效期不超过 24 小时。
- `repay` 在两个钱包认购满额后放款、回款并结清。

签名阶段与 `funding` 相同，需要 `--execute` 和同提交 CI 收据。认购、领取和退款只由验收者自己的钱包完成。

运行告警写入对应 runtime 的 `ops-alerts.jsonl`。可选 webhook 由操作者配置；自动 HTTP 接收测试不表示真实值班人员已经确认。日常维护保留上述能力，但不新增交付门槛。

执行产物使用忽略的 `artifacts/` 或 `test-results/`，不再建立阶段计划、日报、评审报告树。当前文档只维护 README、架构、合约、数据来源、运行说明与人工验收。
