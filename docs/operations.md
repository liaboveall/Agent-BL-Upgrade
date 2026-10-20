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
npm run test:n1
npm run test:n2
npm run test:n3
npm run test:n4
npm run test:n5
npm run test:browser
npm run eval:agent -- --check
npm run preflight
```

W2～W5 是既有资金、权利、证据/支付、运营恢复的集成入口。普通 Node 套件明确跳过的本地 EVM 场景须在对应独立入口实际执行，跳过不算通过。浏览器需安装 Playwright Chromium，或用 `AGENTBL_CHROMIUM_PATH` 指向实际可用的系统 Edge/Chrome。离线浏览器服务不启动正式运营监控，其 ready 状态不能替代实际容器的就绪核验。

`test:n1` 是第一阶段统一本地回归，隔离 runtime，不读取开发者 `.env`，记录源码摘要、每条退出码及原始日志到 `artifacts/n1/<时间>/`。应用测试主进程必须清除 `NODE_TEST_CONTEXT` 后由 Node 创建测试子进程；否则可能退出 0 却零执行，不能算通过。该入口不包含测试网广播、人工钱包或同提交 CI。

`test:n2` 采用同样隔离规则，串行完成12项命令，固定本次技术源码摘要、退出码、失败/跳过与环境到 `artifacts/n2/<时间>/`，并复制浏览器截图/JSON。Hardhat 集成入口共享编译缓存，禁止同时对同一 checkout 编译。N2 的初始失败日志不会被最后结果覆盖。

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

## 完整条款的创建、取回与复算

1. 签发主体在已有业务会话中，通过 `POST /api/rights/materials/:id/financing-disclosure` 创建公共研究条款；输入结构见 `src/rights/disclosure.js`。只放经批准的公开责任地址和来源说明，私有提单仍在加密材料中。
2. 将返回的 `terms_hash` 通过原材料 `/terms` 绑定，收集两个独立审查地址对当前 document/terms 的审核，再 `/publish`。新 revision 不覆盖旧条款；修改后须重新审核。`disclosureFromPricingQuote` 可从可开放的确定性报价产生精确原子金额；研究固定金额场景与自动报价验收分别记录。
3. holder/valuer 的签名和发行使用返回的同一 `terms`。受控实例提供 `GET /api/controlled/offerings/:id/terms?download=1` 下载；只有当前规范链与条款一致时才成功。
4. 用户在确认面板阅读完整条款、责任地址与截止后勾选审阅。前端独立复算，认购 API 与广播检查再次核对；缺材料或报价变更均阻断新增确认。既有退款、领取继续使用原退出路径。
5. 下载的 JSON 可在离线机器独立运行：

```powershell
npm run terms:verify -- C:\path\financing-terms-1.json
```

离线命令仅验证公开文档、政策及 EIP-712，输出精确总本金/目标金额；不读取 `.env`、不请求 RPC 或钱包。其 `chain_state_verified:false` 表示没有据此核验当前规范链，不能用离线 PASS 替代测试网或人工/业务验收。

## 角色工作台与分页读取

管理员通过现有 `POST /api/rights/subjects` 登记组织、钱包和业务角色，向参与者提供返回的身份编号；角色登记仍须配合当前链上权限。用户在资金池面板连接钱包、选择 Live 后，在“融资角色工作台”填身份编号并逐次钱包签名。`POST /api/rights/wallet-challenges` 只为已登记主体生成限量挑战，不接受角色或组织自报；管理员原有挑战入口仍保留。

工作台支持保存虚构铜单证、导入完整研究条款、独立审查及发布、holder 同意、资格和来源更新、发行、放款、回款证明和有界处置。签发/估值输入使用已审研究包中的相应字段；服务器构建受限 EIP-712 请求，用户签名后导出文件交接。登记使用 `{issuance,signature}`，发行使用 `{valuation,valuer,signature}`，完整条款由当前材料绑定；不得手改承诺后沿用旧审核。导入文件限1MiB。新条款使用 `POST /api/rights/materials/:id/financing-disclosure-preview` 进行授权后的无写入预览，确认后再保存并绑定；签发/资格/条款同意预览显示对应对象和截止。角色界面已完成N4的导航与布局本地验收；JSON文件交接不等于N5人工业务流程已经验收。

资金认购、退款、领取和原意图恢复使用 `x-rights-session`；会话钱包及主体须与意图一致。前端会话只存在内存，刷新/钱包/模式变化后重新验证角色，非敏感意图定位符保留。业务会话恢复不替代交易签名。业务主体撤销后可点击“仅验证既有退款与领取”，或以 `exit_only:true` 请求钱包挑战；该会话只能查询/恢复自己的资金意图、退款与领取，不能读取私有材料、认购或发起权利新风险。材料权限、资格撤销与既有退出分开处理。权利操作先 `POST /api/rights/transaction-plans` 准备，审阅后 `POST .../:id/broadcast` 保存一次发送checkpoint，再由本钱包发送；服务从不代签。未知结果用 `GET .../:id` 或 `POST .../:id/transaction` 查原交易，不能自动再发一笔。资金意图也按相同原则保存模式代次、创建区块和nonce；其他主体不能操作。

```text
GET /api/controlled/offerings?from=1&limit=10
GET /api/controlled/offerings?from=11&limit=10&block_number=<上页区块>&block_hash=<上页哈希>
GET /api/controlled/offerings/25
GET /api/controlled/positions?wallet=<钱包>&from=1&limit=10
```

`complete` 仅说明本页是否完整；仍须按 `next_cursor` 读完所有页。`failures` 指明未读到的池，`snapshot` 记录规范块、时间与观察时间；刷新开始新快照，不能混合不同快照的页。指定池同样返回页形响应，未知池404。重组拒绝旧快照；拥塞和超时不返回伪造的空成功。部分持仓失败保留对账提示和未知金额。默认每页十条，最大二十条；页面按同块聚合持仓。

`npm run test:n3` 串行执行13项统一本地检查，包括新增 `test:n3:evm` 的真实本地25池/角色/资金验收、所有既有资金集成、浏览器、Agent和预检。源码摘要覆盖技术文件，docs叙述单独记录。结果、命令原日志、初始失败、EVM余额轨迹及RPC读数进入 `artifacts/n3/<时间>/`。最终结论要求 `source_unchanged:true`、实质执行及全部命令退出0；中途修改源码的绿色运行仍是中间证据。单元故障注入、浏览器HTTP/钱包桩、本地EVM、公共测试网RPC、人工钱包分别报告。

## 部署与续跑

```powershell
npm run deploy:w5 -- --status
```

status 核验链上实例，不广播交易，但会保存本次核验结果和续跑状态。CLI 优先读取 `data/runtime/w5-deployment/deployment-state.json`，其次读取显式选择的收据目录，最后读取 `scripts/config/testnet-deployment-baseline.json` 的冻结基线。基线是当前研究实例的公开部署历史，不含私钥；没有原加密签名材料时不能冒充新实例继续部署。checkpoint 损坏、artifact 改变或 custody 不匹配时必须停止。

`AGENTBL_DEPLOYMENT_EVIDENCE_DIR` 可显式指定 status 产物目录。控制版本 1 已转为应用侧仅退出，旧 CLI 的 `--prepare`/`--activate`/`--smoke`/`--anchor` 被拒绝，避免在旧 checkpoint 上混入新代码或增加风险。直接调用旧链上合约仍受旧代码约束，应用侧关闭入口不能热修旧实例。

合约修复后的新实例使用离线入口 `npm run rights:candidate -- <public-input.json>`。输入包含唯一 `instance_id`、`chain_id` 1439/31337、已有 `governance`/`hub`、待用 `deployer` 和其未使用 `nonce`。1439 必须使用现有公共配置的治理/Hub，以保留历史资产占用；输出为 `artifacts/candidates/<instance_id>/candidate.json`，已存在目录拒绝覆盖。它包含源码/产物摘要、预测地址、七笔未签名部署/绑定事务、治理调用及切换前提，不请求私钥、不广播、不改公共配置。

N5.2 实际发布前必须核验规范链、原 nonce、每份 runtime（含池创建的 RecoveryEntitlements）、绑定和治理延时；未知事务先找原 hash，不能自动重发。新配置记录 `control_version:2` 和真实部署块。新 Registry 共用 Hub，新 Pool 地址形成独立账本目录；通过测试网验收后成对切换两份公共配置。旧 ABI、地址、checkpoint、加密材料、持仓及退出入口保留，不复用历史交易编号。

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

`npm run test:n4` 串行执行13项本地门禁，复跑应用、合约、W2～W5、N3实际EVM、整站浏览器、Agent与预检，保存技术源码摘要、命令退出码、截图和原始失败记录到 `artifacts/n4/<时间>/`。浏览器以中英文390/768/1280/1440px覆盖默认融资入口、角色与条款、25池分页和全部导航的整页宽度。HTTP/Ethereum桩的浏览器检查不替代独立EVM实付证据或真实手机钱包操作。

## N5 候选复现与本机交付

`npm run test:n5` 创建全新本地clone，覆盖本次工作区的公开源码并核对技术文件清单，重新安装两套锁定依赖。不提交/推送，不复制 `.env` 或runtime，仅继承操作系统路径和明确选择的浏览器。依次执行覆盖率、合约、W2～W5、N3真实EVM、浏览器、Agent、预检、两类依赖审计、两次干净构建、本机Docker和600秒离线连续运行；日志、失败和源码清单进入 `artifacts/n5/<时间>/`。覆盖率已执行应用套件，不重复记作两份独立证据。

记录发布证据前先执行 `npm run check`。它与 `test:n5` 都会按 `.gitattributes` 检查技术输入（含未跟踪的新文件）：声明 `eol=lf` 的源码不能仍含 CRLF，否则 Git 提交/checkout 会改变已验证的字节。`-text` 的原始单据、冻结部署收据和 vendor 文件保留原字节。已有证据不能因换行整理而改写摘要；整理后生成新源码清单并重新验证。发布交接还应逐文件比较候选源码和将发布的 Git blob，记录预期 tree、真实暂存区未变及尚未创建提交，不能把 tree 标成已通过 CI 的 commit。

本机镜像标注基线Git提交与实际技术源码SHA-256；有未提交修改时，基线提交不能代替源码摘要。Docker使用随机独立卷、回环端口、非root、只读根、tmpfs、去权限和禁止提权；检查ready/网页、停止后的租约释放、同卷重启及丢卷拒绝初始化。临时容器和测试卷结束后移除，保留镜像ID和日志。

恢复只使用合成两投资者账本和加密研究vault。源目录离线，仅把加密包及两份独立临时密钥挂入替代Linux容器，核对共10份、8,000,000原子单位成本；错误备份密钥、错误vault密钥和缺历史均应拒绝。真实链账由N3 EVM另验；同机合成恢复不证明新测试网实例、原签名权或独立物理机接管。

`npm run inspect:n5` 不加载 `.env` 或私钥，只核验公开现有实例、runtime、签名域及绑定；固定规范块读完各页，记录实际JSON-RPC数、五次读取p95和错误比例。现有池不足25时保留公共25池门槛；五次冒烟也不代表持续压测。公开deployer的latest/pending nonce相等时生成七笔无签名候选事务；nonce是观察值，不是预留。结果进入 `artifacts/n5-readonly/<时间>/`；公共配置、旧checkpoint及账本不改。

CI增加N3角色与25池EVM作业。提交推送后须等待同一完整提交的全部适用必需检查；条件式异地主机恢复跳过需单列。未提交源码、本地绿灯和历史CI不关闭同提交CI门槛。

N5公共执行入口为 `npm run deploy:n5 -- prepare n5-v2-20261019 --execute`，其次为 `activate` 或只读 `status`，同一实例ID必须续用原candidate和journal。执行前要求工作区干净，并在 `artifacts/n5-publish/<完整HEAD>/ci.json` 保存该提交全部15项适用检查成功的GitHub原始收据。入口只接受1439，重新核验旧实例、共用治理/Hub、成员、nonce和runtime；从原加密研究保管读取角色密钥，不将密钥写入输出或候选文件。新状态隔离在 `data/runtime/n5-deployment/<实例ID>/`，原v1 checkpoint不改。

`prepare`按七笔确定性部署/绑定计划执行，沿用明确标注的原研究TEST_USDC，再由两名原治理成员批准13项登记、角色、资产及intake配置；1小时延时保留。`activate`只执行原批准的目标和calldata，并验证新实例七份runtime、签名域与不可变绑定。两个入口均在广播前持久保存原nonce/hash；RPC结果未知时只查原交易，不重新签名或重发。已确认步骤可重复核对，不重复执行。公共配置切换另须完成N5.2资金路径；`active:true`只表示孤立候选治理配置已激活，不等于公共前端已切换或人工已验收。

执行器的实际本地EVM回归：先 `npm run compile:contracts`，再 `node --test tests/n5Deployment.integration.js`。它部署共享Hub的新实例、验证提前执行拒绝、保留旧登记、完成治理和域/runtime核验，并模拟节点已接受但响应丢失后的单次广播恢复；同项也进入现有N3 CI作业。

激活后使用 `npm run deploy:n5 -- funding n5-v2-20261019 --execute`。它建立独立应用vault中的完整公开条款和两地址审核，使用原研究角色的钱包自动完成双资方本金8,000,000、正常兑付10,000,000、失败募集退款2,400,000，以及损失/迟到回款的逐人2,000,005原子单位核验。第二位研究投资者使用governorC地址，角色仍由同一操作员保管；不是独立组织或人工验收。每笔领取/退款同时比较规范交易前一块与交易块的USDC余额，以及池内累计领取/escrow。重复运行只核验原交易。到期或1天处置通知尚未届满时，结果保留具体等待时间和`passed:false`，可在边界到达后用相同命令续跑。

资金入口另建立总计至少25个独立虚构铜单证/池，额外容量池没有认购或放款。`npm run deploy:n5 -- capacity n5-v2-20261019`仅只读，持续600秒、至少5次完整25池固定区块分页，记录实际JSON-RPC数、逐页失败、p95及错误比例，输出到新的`artifacts/n5-capacity/<实例>/<时间>/`。这是顺序全列表查询测量，不冒充并发容量、长期SLA或独立组织验收。资金入口在公共测试网上不调用推进时间的RPC；本地EVM集成入口才注入时钟推进。

容量报告显式记录实际`chain_id`和`public_testnet`；31337的本地结果不能因文件目录或旧scope标签被当作公共证据。`base_head`是源码基线，技术摘要才绑定实际字节；RPC计数仅含测量阶段，不包括初始化的manifest/runtime核验。资金入口同时输出正常/退款/损失的逐项结果和`WAITING_FOR_CHAIN_TIME`及具体边界，退出0不代表等待中的资金路径已通过。25池前需核对各研究角色gas余额；原公共交易费用总上限0.05、独立测试gas补足上限0.04 TEST_INJ保持有效，不因本地夹具预算放宽而改变公共限制。

账本冷同步使用独立120秒预算（仍最多10,000次读取、每段最多2,000块、共享有界RPC队列），当前余额页保持短预算，并在历史同步完成后才开始计时。旧公共实例约15.7万块的实测冷重放需约34秒；不能让20秒页面预算中断恢复。界面在冷恢复期间可显示待对账，不能把尚未完成的链读取当作零余额；120秒或RPC失败仍拒绝宣称已对账，保留原现金事实与错误证据。

2026-10-20资金状态：新v2`n5-v2-20261019`公示已届满，正常、退款、损失及9原子单位迟到回款均通过；179笔检查点、5持仓/17现金事实已与链核对。禁止清空原candidate、owner-cli或deployment-state。当前两份公共配置已准备切换到v2；常驻服务的版本及新旧入口须看本批部署收据。此前5持仓/12现金事实/172笔检查点的加密恢复只代表当时同机Linux容器，不能代替新增7笔后的恢复验收，也未提供交易签名密钥。

该公共实例25池顺序全列表测量已完成603.27秒/20轮、8,820次实际JSON-RPC、0错误，完整扫描p95=30.66秒；逐页固定块、无漏池/重复。原始证据为`artifacts/n5-capacity/n5-v2-20261019/2026-10-18T23-30-54-480Z/capacity.json`。该时延是完整25池列表，不可宣传为单RPC或并发接口p95；公共RPC和并发负载变化需重新测量。

新v2通过全部资金路径后，配置切换还必须接入`data/runtime/n5-deployment/n5-v2-20261019/application/rights`中的材料vault及独立`controlled-capital-0x53d65a42df5431157922fe85ab72c2c7abb7ac99`账本。先对停止写入的新旧runtime分别建立加密恢复点，保留旧v1配置/材料/持仓与退出入口，再对候选服务核验公开条款可读、链/实例/域一致、正常/退款/损失余额、重启及双语布局。只改两份JSON而沿用缺少新材料的旧vault不能视为部署完成；新服务核验失败时沿已保存的旧配置和runtime回退。

崩溃后的根租约和anchor锁都需要核对原持有者。2026-10-20恢复发现旧容器退出后，锁仍记录原容器hostname/PID1；新进程也使用PID1，不能只看PID相同便宣称原写入者仍活着或自动删除锁。先验证具体原容器已停止、无同卷写入者，建立保全证据及加密备份；停机保留残留锁后再启动，检查`/api/ready`及agent启动、链账、材料健康。`/api/health`和Docker healthy只表示进程存活，不能代替ready；原失败日志与锁保留供审计。

## 课程演示与未参与开发者验收

讲解顺序：默认融资页说明虚构铜货物、Singapore → Shanghai和TEST_USDC；完整条款解释本金、补偿、截止、零费与损失；角色工作台说明签发、估值、双审、holder同意和放款；最后由出资人分别核验到账。哈希证明材料未变，不证明真实货物；Hub只覆盖接入登记域；研究地址仍由同一操作员管理。平台离线时用户可依链上规则退出，是相对“签名数据库 + 平台托管”的主要差别。

本地可复跑：`npm run test:n3:evm`。输出轨迹时先将 `AGENTBL_N3_EVIDENCE` 设为新的证据目录，结束后删除该环境变量。入口自行启动并停止本地链，不动公共测试网资金。1 TEST_USDC = 1,000,000原子单位：

| 路径 | 精确整数与结果 | 独立核对 |
|---|---|---|
| 正常 | 两人投入合计8,000,000，回款及领取合计10,000,000 | 各钱包余额、原交易、池escrow归零 |
| 失败退款 | 实认购2,400,000，截止后退款2,400,000 | 原成本退回、份额销毁 |
| 损失与迟到款 | 初始回款4,000,001，迟到款9；最终每人2,000,005 | 烧份额后永久受益权仍收增量 |
| 未知交易 | 已有广播checkpoint但未保存hash/回执 | 查原nonce与规范回执，不再次付款；重组保留审计 |

公共新候选部署并成对切换配置前，Live仍是旧版仅退出实例，不能演示新增v2融资。人工验收需在已核验的新实例上由未参与开发的人独立操作；自动EVM钱包及浏览器桩不得代填人工通过。

1. 记录源码/提交、实例、验收者、日期、设备和钱包版本，以及本人未参与开发的声明；只用研究测试账户。
2. 连接并核对链/实例，验证已登记身份；读完整条款并复算金额、收款方、报价、截止、零费。先拒签一次，核对资金未动且无伪回执。
3. 按待办完成材料交接、两地址审核、holder同意、发行、两资方分别认购、固定融资主体收款、实回款、独立领取；逐次记录本人实际签名和规范交易。
4. 在另一失败募集池做截止退款，用浏览器或独立RPC记录前后余额、份额和escrow。金额不符时停止新增风险并保存证据。
5. 观察损失及烧份额后的迟到回款；刷新/断网后的未知结果只恢复原交易。切换钱包/模式撤销旧预览，既有退款/领取仍可达。
6. 实际手机另测连接、切链、拒签、确认、回前台及恢复；390px桌面不能代填手机通过。验收者说明区块链作用和信任边界，记录受阻步骤。

人工收据至少保存：`source_sha256`、完整`commit`、`chain_id`、新地址及部署块、验收者、设备/钱包、逐步结果、实际签名次数、原hash/规范块、前后余额整数、独立查询来源、失败/重试及未完成项。没有实际验收者和签名时维持PENDING，不生成示例PASS。
