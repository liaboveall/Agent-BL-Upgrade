# 运行、测试、部署与恢复

范围：离线 Demo 和受控 Injective EVM 测试网研究应用。当前不部署公网服务器，不承载已获业务验收的真实贸易融资。产品缺口及发布门禁见 [开发规划](development-plan.md)。

## 本地启动

需要 Node 22.13+；Windows 本机使用对应平台的 Node/Hardhat 依赖，不混用 WSL 的原生模块。

```powershell
npm ci
npm --prefix hardhat ci
npm run compile:contracts
npm run dev
```

`dev` 自动执行前端构建。生产方式为先 `npm run build`，再 `npm start`。默认 Demo 不需要钱包，不发送融资交易，也不生成伪造 hash。

复制 `.env.example` 到本机忽略的 `.env`，仅填写实际需要的变量，不在终端打印完整配置。公开钱包/网络配置为 `public/application-config.json`；受控实例为 `public/rights-instance.json`。二者的网络和核心地址需一致。服务端通过 `AGENTBL_RIGHTS_CONFIG` 选择实例，核对 chain、六份 runtime、治理、签名域及权限绑定，实际核验后才能视为连接成功。

受控融资需合资格钱包、条款接受、管理员认证、独立材料密钥和持久 `AGENTBL_RUNTIME_DIR`。材料/vault、报告付款、部署和可选证据锚定密钥分别管理；锚定使用专用 `AGENT_ANCHOR_PRIVATE_KEY`，不复用融资密钥。

研究场景使用多个地址，但研究密钥仍由同一操作员保管。钱包自动化通过不能证明独立组织治理或真实人工验收。

## 测试与产物

```powershell
npm run lint
npm run check
npm run build
npm test
npm run test:contracts
npm run test:w2
npm run test:w3
npm run test:w4
npm run test:w5
npm run test:browser
npm run eval:agent -- --check
npm run preflight
```

W2～W5 是既有资金、权利、证据/支付、运营恢复的集成入口。普通 Node 套件明确跳过的本地 EVM 场景须在对应独立入口实际执行，跳过不算通过。浏览器需安装 Playwright Chromium，或用 `AGENTBL_CHROMIUM_PATH` 指向实际可用的系统 Edge/Chrome。离线浏览器服务不启动正式运营监控，其 ready 状态不能替代实际容器的就绪核验。

`npm run validate` 是完整验收：lint/check/build、应用及覆盖率、合约、W2～W5、浏览器、Agent、preflight、依赖审计、两次干净构建、容量及连续运行。新 checkout 和同提交 CI 都需完成，不能把旧报告的数量沿用为新结果。

| 默认产物位置 | 内容 |
|---|---|
| `artifacts/validation/runs/<时间>/` | 完整验收、命令退出码、源码清单、失败日志；latest-run 仅是索引 |
| `artifacts/deployment/runs/<时间>/` | 部署/只读状态、测试网操作和恢复收据 |
| `artifacts/clean-build/<时间>/` | 两次干净构建对比 |
| `artifacts/load/<时间>.json` | 容量测量 |
| `artifacts/agent-evaluation/<时间>/` | Agent JSON 结果和可读报告 |
| `artifacts/evaluation/provider-runs/` | 来源、模型、行情和筛查的独立运行 |
| `test-results/` | Playwright 当前执行输出 |

这些目录由 Git 忽略，不进入默认文档。重要结果在规划交付记录中绑定源码、执行环境和外部证据链接，并在发布/归档存储中保留。失败、重跑原因和跳过不能被后续成功覆盖。

`preflight --report <文件>` 同时把每个子命令的原始输出保存在 `<文件>.commands/`，用于定位子套件失败，不能仅凭最后一行摘要判断原因。

preflight 主进程会读取本机配置并运行 Demo reset 等检查。已有部署的机器应隔离测试 runtime，并禁止读取 `.env`；测试 runner 的上下文由脚本自行清除后创建：

```powershell
$env:NODE_TEST_CONTEXT = 'preflight-offline'
$env:AGENTBL_RUNTIME_DIR = Join-Path $env:TEMP ('agentbl-preflight-' + [Guid]::NewGuid())
npm run preflight -- --report artifacts/preflight/result.json
Remove-Item Env:NODE_TEST_CONTEXT, Env:AGENTBL_RUNTIME_DIR
```

如需部署就绪核验，使用独立的实际状态入口；本地套件应与实际受控实例配置隔离。

## 部署与续跑

```powershell
npm run deploy:w5 -- --status
```

status 核验链上实例，不广播交易，但会保存本次核验结果和续跑状态。CLI 优先读取 `data/runtime/w5-deployment/deployment-state.json`，其次读取显式选择的收据目录，最后读取 `scripts/config/testnet-deployment-baseline.json` 的冻结基线。基线是当前研究实例的公开部署历史，不含私钥；没有原加密签名材料时不能冒充新实例继续部署。checkpoint 损坏、artifact 改变或 custody 不匹配时必须停止。

`AGENTBL_DEPLOYMENT_EVIDENCE_DIR` 可显式指定新产物目录。当前 `--prepare`/`--activate` 是既有部署编排，`--smoke` 执行测试资金生命周期，`--anchor` 注册并锚定版本；这些操作涉及外部测试网交易。此前用户已授权本轮必要测试与部署，目标限本机 Docker 与受控测试网；不扩大到公网服务或真实商业资金。

合约修复后的新实例发布属于 N1.6/N5.2。不要改 artifact 后强行续跑旧 checkpoint，不要重置历史、复用旧交易编号或覆盖旧地址。新旧签名域、账本和 Hub 占用关系需有迁移方案。

容器镜像由同源码编译合约和前端，携带所需 runtime artifacts。运行使用非 root、只读根、tmpfs、cap-drop ALL、no-new-privileges，持久挂载实际 runtime。镜像和配置绑定提交/源码摘要；`/api/ready` 与 `/api/controlled/status` 均通过后再接收新操作。

## 监控与安全停止

| 入口 | 语义 |
|---|---|
| `/api/health` | 进程存活，不等于可接收新增操作 |
| `/api/ready` | 非敏感就绪、范围和版本，异常返回 503 |
| `/api/ops/status` | 管理员认证；存储、实例、链账、来源、积压和证据状态 |
| `/api/ops/metrics` | 管理员认证；Prometheus 指标 |
| runtime 的 `ops-alerts.jsonl` | 持久告警；异常和恢复分别记录 |

durable 写入失败、关键历史缺失、链确认未知、实例改变、账务不平和来源失效等情况停止新增认购/发行/放款及收费。读取、对账、已付款恢复、已有领取及退款保持入口可达；实际执行仍受链上条件约束。

每个 runtime 仅一个写入进程，`.runtime-lease` 同时约束停机备份。首次初始化后使用 `AGENTBL_REQUIRE_EXISTING_RUNTIME=true`，`ops-required-history.json` 记录必须保留的材料及历史，丢卷时不能空启动。不要因为持有者 hostname 不同就自动抢占租约。

停止容器使用 `docker stop -t 30 <container>`，确认进程退出和租约释放。若强制终止留下租约，先确认原容器已退出且没有其他挂载写入者，保存 owner 记录后再人工退役；不能对未知共享目录直接递归删除。

告警接收端通过 `AGENTBL_ALERT_WEBHOOK`/`AGENTBL_ALERT_TOKEN` 配置。自动 HTTP 接收测试与真实值班人员确认分别记录。

## 资金、中断与备份恢复

受控 `/offerings` 提供规范块上的融资快照，`/positions?wallet=...` 对账实际事件与余额。认购/领取/退款先保存未签名意图，再固定 allowance、nonce、起始块和 calldata。恢复只寻找原交易，不自动重发；重组撤销确认并保留历史；超过搜索窗口时需原钱包 hash。

```text
npm run runtime:backup -- create --directory <已停止的runtime> --key-file <独立备份密钥> --output <新加密包> --configuration <实例JSON> --revision <源码版本>
npm run runtime:backup -- restore --directory <新目标> --key-file <独立备份密钥> --input <加密包>
```

先停止应用和共享目录 CLI，只做停机一致性快照。备份、vault 和交易签名密钥分开保管。摘要、初始化标记、历史和配置一起校验；错误密钥、篡改、路径逃逸、大小写冲突、链接和已有目标拒绝恢复。整包校验后才写新目录。

`npm run recover:w5 -- <同源码镜像>` 将源 runtime 暂时改名离线，只把加密包和独立密钥挂入新 Linux 容器，验证材料并重建链账，再还原源目录。运行前停止当前实例；同物理机隔离结果不等于异地组织恢复。

独立 runner 的恢复流程由 `scripts/remote-recovery-w5.mjs` 编排，使用加密快照和临时分片 secrets，零广播恢复材料与链账，不提供原交易签名私钥。完成后按该脚本 cleanup 清除临时上传物。数据恢复、签名权恢复与组织接管分别验收。

现有容量入口默认范围是离线应用和研究日志；它不证明多池真实 RPC 路径性能或商业 SLA。N3.2/N5.3 要补充多池查询、限流、超时及故障恢复测量。

## 可选服务

MCP：`npm run mcp:stdio`。离线报告：`npm run smoke:x402`、`npm run x402:intel`。`npm run smoke:x402:live` 会进行外部测试网付款，执行前核对目标与配置。付款成功、报告可取回和报告业务准确性是三项分别验证的事实。数据和模型配置见 [data-sources.md](data-sources.md)。
