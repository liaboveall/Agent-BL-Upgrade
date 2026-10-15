# 🚀 AgentBL 部署指南

AgentBL 的后端是一个**常驻的 Node.js HTTP 服务**（[`src/app/server.js`](../src/app/server.js)），同一个进程既提供 `/api/*` 接口，也托管 [`public/`](../public/) 下的前端页面。因此它需要部署在能**长期运行进程**的环境里（本机、Docker、VPS、Railway 等）。

> ⚠️ **不支持 Vercel / Netlify 这类纯静态 + Serverless 平台。** 项目没有拆成 serverless 函数，池子状态也保存在进程内存里，部署到这些平台后前端能打开，但 `/api/*` 会全部失效。

---

## 📋 部署前检查

- [ ] Node.js ≥ 20.11（`node -v`；仓库的 `.nvmrc` 是 22，CI 测试 22 和 24）
- [ ] 本地可以正常运行：`npm run dev`，打开 http://localhost:3000
- [ ] 检查通过：`npm run lint`、`npm run check`、`npm test`
- [ ] 赛前自检通过：`npm run preflight`
- [ ] `.env` 已准备好，且**没有**提交到 Git

### 环境变量

复制模板后按需填写：

```bash
cp .env.example .env
```

**Demo 模式下所有 key 都是可选的。** 不填时，AI 估值、行情、世界风险情报都会回退到确定性的离线数据，演示照样可用。每个变量的说明和默认值见 [`.env.example`](../.env.example)，部署时最常用的有：

| 变量 | 用途 |
|---|---|
| `PORT` / `HOST` | 监听端口（默认 `3000`）和绑定的网卡；不设置 `HOST` 时监听所有网卡，Docker 镜像里设为 `0.0.0.0` |
| `TRUST_PROXY` | 前面有几层反向代理（单层 Nginx 填 `1`）。只有设置了它，限流才会读取 `X-Forwarded-For`；直接暴露在公网时**不要设置**，否则客户端可以伪造来源 IP |
| `AGENTBL_ADMIN_TOKEN` | 至少 16 个字符。切换运行模式（进入或离开 Live）需要它；没设置时，只要 Live 已配置，切换就被禁用。生成：`openssl rand -hex 24` |
| `DEMO_MODE` | 运行模式，默认 Demo；Live 模式不会静默回退到模拟交易 |
| `AGENTBL_RUNTIME_DIR` | x402 收据、报告缓存、决策日志、Mystery 记录的目录（默认 `data/runtime`），必须可写且持久 |
| `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` / `Tencent_API_KEY` | 任选一个 LLM 提供方。**只保存在服务器**，浏览器通过同源中继 `/api/llm/chat` 调用（见下文“LLM 中继”） |
| `LLM_MODEL` | 全项目 API 共用模型名，默认 `x-test-2`；腾讯不再单独锁定旧模型。端点必须提供目标模型；未进行真实提供方验证 |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT` / `AZURE_OPENAI_API_KEY` | 也可改用 Azure OpenAI 作为 LLM 提供方 |
| `METALPRICE_API_KEY` / `ALPHAVANTAGE_API_KEY` | 实时铜价 |
| `COMTRADE_PRIMARY_KEY` | UN Comtrade 历史成交价 |
| `XAPI_KEY` | 世界风险情报（新闻 / 社交 / 预测市场） |
| `INJECTIVE_RPC_URL` | Injective 测试网 RPC（有默认值） |
| `X402_MODE=live`、`X402_FACILITATOR_URL`、`X402_PAY_TO`、`X402_PUBLIC_BASE_URL` | Live 模式的 x402 付费情报，详见 [x402-integration.md](./x402-integration.md) |
| `AGENTBL_MCP_API_URL` | stdio 新增运行时工具/资源连接的现有后端，默认 `http://127.0.0.1:3000`；远程必须 HTTPS，禁止 URL 凭据和重定向 |
| `AGENTBL_PUBLIC_BASE_URL` | A2A 卡片、Bazaar 目录和 Live 402 的规范公开 HTTPS origin；优先于 `X402_PUBLIC_BASE_URL`。未配置时发布 localhost 开发地址，不信任 Host/转发头 |
| `MCP_HUMAN_APPROVAL_TOKEN` | MCP 实际写入与 `submit_agent_event` 的带外审批令牌；默认 dry-run 不入队，令牌不授权后续链上执行 |
| `PAYMENT_ATTESTOR_PRIVATE_KEY`、`PRICING_UPDATER_PRIVATE_KEY`、`SIGNER_KEYS_STRICT` | 服务器按角色使用的最小权限签名密钥，见“链上角色与密钥” |
| `AGENT_ENABLED`、`AGENT_AUTONOMY`、`AGENT_PROTECTED_CHAIN_POOLS`、`AGENT_MAX_PRICE_MOVE_BPS` 等 `AGENT_*` | Agent 运行时的开关、自主级别、阈值，见“Agent 运行时”；完整列表在 `.env.example` 第 10 节 |

前端连接的合约地址**不走环境变量**，而是读取 [`public/chain-config.json`](../public/chain-config.json)。重新部署合约后，部署脚本会自动更新这个文件（也可以用 `npm run migrate:chain-config`）。

### 运行时数据

服务会把 x402 收据、报告缓存、Mystery Voyage 揭晓记录和 Agent 运行时的状态写入 `AGENTBL_RUNTIME_DIR`（默认 `data/runtime/`，已在 `.gitignore` 中忽略）。生产环境要保证这个目录**可写且持久**，否则重启后这些记录会丢失。池子 / 认购数据只在内存里，重启即清空。

Agent 运行时写入的文件：`agent-decisions.json`（决策日志）、`agent-activity.jsonl`（活动流，带单调序号，超过 5 MB 轮转）、`agent-events.jsonl` 与 `agent-event-index.json`（事件及其处理状态）、`agent-approvals.json`（审批）、`agent-pools.json`（案例与链上池的映射）、`agent-traces.jsonl`（决策追踪）。启动时会清理崩溃遗留的 `*.tmp` 文件。

---

## 方案 1：直接用 Node 运行（本地 / 演示）

```bash
npm install
npm start          # 等价于 node src/app/server.js
```

## 方案 2：Docker（推荐）

```bash

# docker compose：读取 .env（没有也能启动），数据放在命名卷里
docker compose up -d --build        # http://127.0.0.1:3000

# 或手动
docker build -t agentbl .
docker run -d -p 127.0.0.1:3000:3000 --env-file .env \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -v agentbl-runtime:/app/data/runtime agentbl
```

镜像的要点：

- 基于 `node:22-alpine`，多阶段构建，只装生产依赖，**以非 root 用户（`node`）运行**；
- 只包含 `src/`、`public/`、`data/` 和 `scripts/lib/`，不含合约、测试和文档；
- 唯一需要写入的位置是 `/app/data/runtime`（挂成卷），所以可以用只读根文件系统；
- `docker-compose.yml` 默认只把端口发布到 `127.0.0.1`。要对公网提供服务，请在前面放一个带 TLS 的反向代理（见方案 3），不要直接发布端口；
- 镜像自带健康检查（`GET /api/health`）。

## 方案 3：VPS / 云服务器（PM2 + Nginx）

```bash
npm ci --omit=dev
npm install -g pm2
pm2 start src/app/server.js --name agentbl
pm2 save && pm2 startup
```

Nginx 反向代理（同时在 `.env` 里设置 `TRUST_PROXY=1`）：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 与 AGENTBL_MAX_BODY_BYTES（默认 1 MiB）保持一致
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 实时活动流（SSE）：不能被代理缓冲
    location = /api/agent/activity/stream {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

HTTPS：`sudo certbot --nginx -d your-domain.com`

## 方案 4：Railway 等容器托管平台

在 [railway.app](https://railway.app) 选择 *Deploy from GitHub*，平台会识别 Dockerfile 或 Node 项目。启动命令用 `npm start`，在平台面板中填写环境变量（用 Dockerfile 部署时 `HOST` 已经是 `0.0.0.0`；用 Node 方式部署则不要设置 `HOST`）。如需保留运行时数据，挂载一个持久卷到 `/app/data/runtime`。

---

## 🔒 安全与上线检查

### 浏览器端

- 页面不加载任何第三方 CDN 脚本：`ethers` 和 `@cosmjs/stargate` 自托管在 [`public/vendor`](../public/vendor/)，`npm run vendor:check` 会校验它们的 SHA-256；
- 服务器给页面发送严格的 Content-Security-Policy（`script-src 'self' 'wasm-unsafe-eval'`，`connect-src` 只包含同源和链配置里的 RPC/Explorer）。如果你把前端放到别的域名下或加了新的第三方脚本，需要同步调整 [`src/app/security.js`](../src/app/security.js)。

### LLM 中继

所有 Agent、Copilot、视觉/文本抽取、共识、评测与 CLI 的 API 默认模型均为 `x-test-2`，由 `LLM_MODEL` 统一配置；空白值回退该默认。Azure 请求体同样使用它，`AZURE_OPENAI_DEPLOYMENT` 保留为实际资源路由，需指向提供目标模型的部署。历史提供方证据不证明新模型可用。

WP2.9 的五个无状态分析接口见 [agent-api.md](agent-api.md)。`AGENT_API_RATE_LIMIT_PER_MIN=30` 控制共用客户端预算，`AGENT_API_MAX_CONCURRENCY=4` 控制全局并发；请求体仍受 `AGENTBL_MAX_BODY_BYTES` 限制，单份文档受 `AGENT_UPLOAD_MAX_BYTES` 限制。接口不写上传作业、决策、审批或交易；可选简报润色及已开启的视觉/补全可能使用模型额度。

Copilot WP3.6 使用额外的 `/api/copilot/sessions/:id/stream` 长连接，与消息响应的短 SSE 分开。代理应关闭缓冲并转发 `Last-Event-ID`；续接只发送最新已持久化的重排快照，合并中间通知。删除、TTL 到期、模式重置关闭订阅；重排不延长 TTL，也不调用模型。`copilot-sessions.json` 同时保存有界动作卡片和快照，文件仍应置于独立运行时卷。Demo 池/持仓重启清空的边界没有改变。

确认卡片最多有效五分钟。Demo 认购确认会记一次带 Copilot 来源的持仓；Live/report 准备为 `CONFIRMING`，禁止重复准备，不能用这个状态判定链上成功。Live 卡片必须取得 PoolRegistry 中已映射池的链上报价；钱包只使用浏览器的用户签名者。现有认购合约不收取 USDC、无价格上限参数；发送后报价或回执不匹配需人工对账。真实验收逐笔遵守实施规划 §16，详见 [copilot.md](copilot.md)。

投资者 Copilot 通过同源的 `/api/copilot/query` 或 `/api/copilot/sessions/:id/messages` 请求服务器。服务器负责偏好解析、最新池检索、排序和解释；旧 `/api/llm/chat` 保留为兼容中继。key 留在服务器。Copilot 遵守 `LLM_PROXY_ENABLED`、`LLM_MAX_TOKENS_CAP`（默认 2048，推理模型可调高或设为 0）和 `LLM_PROXY_MAX_CONCURRENCY`（默认 4；繁忙时使用确定性回退）；消息接口和旧中继共用 `LLM_RATE_LIMIT_PER_MIN` 的每客户端限流桶（默认 30）。每轮最多两次模型调用，分别用于偏好解析和解释，单次超时 15 秒。金额、收益等明确数值始终取自确定性解析；模型解释的数字未经结构化结果核对不会展示。

但这个接口**本身没有登录**：任何能访问站点的人都能在限流范围内消耗你的 LLM 额度。公开部署时请：

1. 在 LLM 提供方的控制台给这个 key 设置**消费上限**；
2. 或者设置 `LLM_PROXY_ENABLED=false`，Copilot 仍可使用确定性偏好解析、检索排序和模板解释；
3. 确保设置了正确的 `TRUST_PROXY`，否则所有用户会共用同一个限流桶（或被伪造 IP 绕过）。

### 运行模式与 Live

- 在 `.env` 里设置 `AGENTBL_ADMIN_TOKEN`；Live 模式的切换请求需要带上它。页面上点击模式开关时会提示输入，令牌只保存在当前标签页的 `sessionStorage`；
- Live 需要 `X402_MODE=live`、`X402_FACILITATOR_URL`（HTTPS）和 `X402_PAY_TO`；如果服务在代理后面，还要设置 `X402_PUBLIC_BASE_URL`。收款地址和付款钱包都需要有测试网 USDC / INJ。

### 链上角色与密钥

服务器不再用合约 owner 密钥签名，而是按角色使用独立的、只授权一个功能的密钥：

| 角色 | 环境变量 | 在链上授权 |
|---|---|---|
| 写入 `PaymentOracle` 付款证明 | `PAYMENT_ATTESTOR_PRIVATE_KEY` | `PaymentOracle.setAttestor(<地址>, true)` |
| 向 `RiskPricingOracle` 推送价格（MCP 工具、Agent 批准后的定价动作） | `PRICING_UPDATER_PRIVATE_KEY` | `RiskPricingOracle.setUpdater(<地址>, true)` |
| （可选）Agent 直接发送离港、付款/到港证明、结算 | `AGENT_EXECUTOR_PRIVATE_KEY` | `RWAOfferingPool.setAgentExecutor(<地址>, true)` |

`DEPLOYER_PRIVATE_KEY`（合约 owner）只在你运行 `cd hardhat && npm run deploy:all`（或 `deploy:protocol`、`deploy:payment-oracle`）的机器上需要，**不要放到对公网的服务器上**。设置 `SIGNER_KEYS_STRICT=true` 后，上面两个角色不会再回退到 owner 密钥。

### Agent 运行时

**Copilot 会话**：服务器入口把结构化偏好保存在 `AGENTBL_RUNTIME_DIR/copilot-sessions.json`，默认有效期 `COPILOT_SESSION_TTL_SEC=86400`、最多 `COPILOT_MAX_SESSIONS=500` 个活跃会话。会话 ID 不可猜，作为读取和删除该会话的凭据；不保存原始聊天、钱包或个人信息。切换 Demo/Live 或重置 Demo 会清空并持久化会话失效，旧会话返回 404/409，重启后也不能恢复为有效会话。`createServer()` 的测试实例只使用内存。搜索框用无状态单轮接口，悬浮助手用多轮会话。消息的 SSE 先发结构化结果，再发完整且已核对数字的解释；WP3.6 通过独立的 /api/copilot/sessions/:id/stream 推送决策驱动的推荐重排，续传规则见上文。

**单证界面**：上传文件的真实 base64 内容进入 `/api/agent/ingest`，作业进度通过现有活动 SSE 刷新，显示抽取字段及行号、方法、置信度。文本、Markdown 和 PDF 文本层支持抽取；扫描或抽取失败进入 OCR_REQUIRED，图片可选视觉抽取仍须人工复核。真实模型质量另行验收。`POST /api/agent/jobs/:id/review` 用于给 HOLD 作业提交修正单证，Live 需要管理员令牌；产生新作业和 `REVIEW_RESOLVED` 事件，保留旧记录，并重跑全部检查，不能强制跳过注入或合规阻断。持仓始终是服务器的 Demo 内存记录，并显示当前镜像状态和关联决策；服务器重启后清空。

服务器入口会自动启动 Agent 运行时（`AGENT_ENABLED=false` 可关闭，决策和活动仍可读取）。`createServer()` 本身不启动任何定时器。

**自主级别**（`AGENT_AUTONOMY`，也可在运行时用 `POST /api/agent/control` 调整，只改内存）：

| 取值 | 含义 |
|---|---|
| `auto` | 仅 Demo 默认值：可逆动作自动执行，**全部是模拟**（链下池子，返回 `demo:` 引用，不产生交易哈希）。不可逆动作（结算、冻结、清算）和记录付款证明仍需审批 |
| `propose` | 所有会改变状态的动作都进审批队列 |
| `observe` | 只记录，不执行 |
| `off` | 全部拒绝 |

**Live 下 Agent 只提方案**：即使配置成 `auto`，也按 `propose` 处理，启动时会警告，`GET /api/agent/status` 的 `autonomy.downgraded` 为 `true`。每个动作都要管理员批准，批准后才会有任何链上动作。

**审批与签名**（需要 `AGENTBL_ADMIN_TOKEN`；Demo 下没有配置令牌时开放）：

- 定价类动作（改价、暂停、恢复、冻结、清算）：批准后服务器用已授权的 `PRICING_UPDATER_PRIVATE_KEY` 调 `RiskPricingOracle.updatePricing`，等回执并核对事件后才算完成；
- 单证开盘：先查 `isUnique`。新货物生成 `mintEBLV2 → pledge → createOffering` 的三步 owner 提案；依赖编号只取自已核验回执，不预测计数器。批准后分别 dry-run，再以 `--step 0/1/2 --confirm` 逐笔发送；三步都核验并重新读链后才登记池映射。已登记货物只提出关联方案，批准后核验已有 eBL/pool，不发交易、不改价格。实现、恢复操作与本地证据见 [live-opening.md](live-opening.md)，真实交易仍按实施规划 §16 逐笔授权；
- 需要执行者角色或 owner 的动作（离港、付款证明、到港证明、结算、取消）：批准后状态为 `AWAITING_OWNER_SIGNATURE`。运维者在**自己的电脑上**运行：

  ```bash
  npm run agent:approve -- --list                       # 列出等待签名的审批
  npm run agent:approve -- --id <审批号>                # 默认 dry-run：打印交易并做 staticCall 预检
  npm run agent:approve -- --id <审批号> --confirm      # 用本机的 DEPLOYER_PRIVATE_KEY 签名发送，并把 tx 回填给服务器
  npm run agent:approve -- --id <开盘审批号> --step 0   # 开盘：只预检下一步
  npm run agent:approve -- --id <开盘审批号> --step 0 --confirm # 只发送所选的一笔，完成后再处理 1、2
  npm run agent:approve -- --id <审批号> --step 0 --attach-tx <交易哈希> # 已广播交易只回填，不签名/发送
  ```

  服务器收到哈希后会**自己去链上读交易和回执**，核对合约、方法、完整参数、发送者和事件字段，全部一致才标记完成；只有一个哈希是不会被信任的。CLI 在忽略的 `AGENTBL_RUNTIME_DIR/owner-cli/` 保存无密钥的广播检查点：已有哈希先回填，未知结果停止重试；服务器进程不读取 owner 密钥；
- 可选升级：配置 `AGENT_EXECUTOR_PRIVATE_KEY`（并由 owner 调 `RWAOfferingPool.setAgentExecutor(<地址>, true)`）后，执行者角色的 4 个动作改由服务器直接发送。它**不会**回退到 owner 密钥。

**受保护池**：`AGENT_PROTECTED_CHAIN_POOLS`（默认 `2`，即 Live 演示用的铜货池）。对它提出的冻结、清算、结算、取消，策略直接拒绝，owner CLI 也拒绝，保证“改价 → 暂停 → 恢复”可以反复演示。

**Live USDC 结算证明（WP2.6）**：明确配置 `AGENT_SETTLEMENT_RECIPIENT`（默认空，关闭 Live USDC 接入），服务器与 owner CLI 使用同一个贸易还款收款地址；它不继承 `X402_PAY_TO`。提交 `proof_source: "usdc-transfer"` 与 USDC 面额，例如 `repayment_amount: "1.234567"`，服务器校验既有测试网 USDC Transfer、收款地址、精确原子金额 `1234567`、`AGENT_CHAIN_CONFIRMATIONS` 及规范区块后才入队。付款和到港记录分别审批；链上双证明齐备才补提 SETTLE，结算仍独立审批。回执绑定、重启/广播恢复、本地证据及限制见 [live-settlement.md](live-settlement.md)。合约不托管或分配资金，管理员负责商业关系及实际到港证明的核对。

**紧急停止**：`POST /api/agent/control {"action":"emergency_stop"}`（`"stopped": false` 解除）。紧急停止期间只允许暂停；Live 下链上合约自己的 `emergencyStopped` 也会被读取。

**反向代理**：活动流是 SSE（`/api/agent/activity/stream`），每条消息带 `id:`，断线重连时浏览器会带上 `Last-Event-ID`，服务器补发错过的事件。Nginx 需要对这个路径关闭缓冲（应用已发送 `X-Accel-Buffering: no`），并保持 `proxy_read_timeout` 大于心跳间隔（默认 25 秒）。

**Demo 重置**（`POST /api/demo/reset`）会清空 Demo 模式下的事件、决策、审批和活动并重建链下池子；**绝不清除 Live 的记录**。

**交易恢复**：广播后的回执查询超时保持 `EXECUTING`，下一 tick 按持久化哈希查回执，不会重新广播；缺少哈希的定价动作仅按精确 oracle 防重放 ID 只读恢复，仍无法确认时保持 `reconciliation_required`，需运维对账。暂时性 RPC 错误不能被写成成功或改为模拟。旧模式/世代审批不能执行，已广播的 Live 事实也不能改变新 Demo 池。恢复矩阵、局限及 `npm run eval:agent` / 61 项 preflight 说明见 [agent-reliability.md](agent-reliability.md)。

**单证接入**（`POST /api/agent/ingest`）：

- 请求体 `{ case_id?, documents: [{ name, mime_type, text | content_base64 }], exporter_preferences? }`。类型白名单是 `text/markdown`、`text/plain`、`application/pdf`、`image/png`、`image/jpeg`，并用文件头（魔数）核对真实类型；单个文档上限 `AGENT_UPLOAD_MAX_BYTES`（默认 8 MiB，base64 编码前）；一个请求最多约 3 个满额文档。
- 文件按内容的 SHA-256 保存在运行时目录的 `uploads/`（**不在 `public/` 下**），元数据和作业在 `ingest-documents.json`、`ingest-jobs.json`，由单证生成的案例在 `cases/`。同一内容重复上传返回同一个作业，不会产生第二个决策。
- 返回的 ENI 记录是 **mock**（`mode: "mock"`、`verified: false`），只表示服务器收到了文件，不代表任何登记机构核验过。
- Demo 下无需令牌；Live 下需要 `AGENTBL_ADMIN_TOKEN`。进度从 `GET /api/agent/jobs/:id` 查看，加 `?wait=1` 可以等流水线跑完再返回。
- 文本、Markdown 和 PDF 文本层已接入；PDF 保留页码/页内行号，30 页、200,000 字符、10 秒上限，由独立 Worker 解析。无文本层（含混合 PDF 的扫描页）标 `OCR_REQUIRED`；损坏、加密和超限保留独立错误码并挂起。怀疑含有“对机器下指令”的文本、关键单据互相矛盾、解析不全，都会得到 `HOLD_FOR_REVIEW` 且**不开池**；合规关键字阻断得到 `REJECT`。
- `AGENT_VISION_ENABLED=false`（默认）：设 true 且已配置支持内联图片和严格 JSON 的模型时，对 PNG/JPEG 调用视觉抽取；`AGENT_DOCUMENT_LLM=false`（默认）：设 true 时为缺字段的文本调用模型补全。开启后相应单证内容会发送至配置的提供方。模型无工具、字段经 zod 和原文证据校验；视觉置信度最多 0.75，始终复核；模型失败或冲突也复核，确定性结果不被覆盖。详细流程、依赖选型及验收见 [document-extraction.md](document-extraction.md)。
- 中文仓单输出独立 `warehouse_receipt`；与发票核对数量、仓单号、HS、币种和货值。人民币金额保持 CNY，不推测为 USD 融资，需人工复核。
- `AGENT_VALUATION_LLM`（默认 `true`）决定估值步骤是否使用已配置的 LLM；LLM 失败或未配置时自动回退确定性路径，决策里会记录 provider。

**监控**：服务器入口每 `AGENT_MONITOR_INTERVAL_SEC` 秒检查一次。世界风险只在**变化**时产生事件（第一次观察只是基线；连续 `AGENT_RISK_CLEAR_TICKS` 次平静才算解除，避免来回抖动）。保险在到期前 `AGENT_INSURANCE_WARN_DAYS` 天提醒，过期且池子活跃时提议暂停；Demo 下只在场景时钟下检查，Live 下用真实时钟并且只看已映射到链上的池子。没有配置 xAPI 时世界风险来自离线夹具，**夹具信号只记录，不进入价格**。

**链上监听（WP2.7）**：持久化 Live 运行时默认每 `AGENT_CHAIN_POLL_SEC=15` 秒用独立只读连接读取已确认日志，每批最多 5000 块；Demo 不请求 RPC。`AGENT_CHAIN_WATCHER_ENABLED=false` 可显式关闭；`AGENT_CHAIN_START_BLOCK` 默认空，从最早监听合约部署区块读取，缺失部署区块时核对部署回执，不能跳过历史。游标和确认镜像持久化在 `agent-chain-cursor.json`；配置、分叉或抵押映射冲突会保留证据并要求对账。链状态未知/仍追赶时暂停 Live 状态变更提案，已有审批等待成功轮询再恢复。本地停止不能解除链上停止。配置、隔离浏览器证据与运维恢复步骤见 [chain-watcher.md](chain-watcher.md)。

**Demo 场景**：`GET /api/agent/scenarios` 列出 `copper-lifecycle`、`copper-typhoon`、`warcrisis-hormuz`、`insurance-gap`。控制台使用 `POST /api/agent/demo/run {scenario, speed}` 启动后台播放、`GET /api/agent/demo/run` 查看进度、`POST /api/agent/demo/stop` 停止并等待当前步骤收尾；写接口仅 Demo 可用，管理员令牌若已配置则必须提供。完整铜货场景从三份实际样例文件开始，使用离线确定性处理；付款和结算仍各需一次审批。请求 speed 只改变播放间隔。旧的手动 `scenarios/:name/start|step|run|stop` 接口保留，与后台播放互斥。普通播放保留历史，显式重置 Demo 才清理 Demo 记录；计时器在服务器重启后不自动恢复。

**Phase 4 证据联动**：`GET /api/agent/references` 提供当前模式/generation 的各案例最新引用和池镜像；Live 只返回有链上映射的池。`agent-decisions.json` 保存 `quote_snapshot`，历史瀑布图与当前认购价格分别展示；报告付款交易和决策执行交易分别标明，没有报告/交易时不生成编号或浏览器链接。模型用量使用实际返回的元数据，缺失值不估计。中英/窄屏、弹窗焦点、后台停止及复现证据见 [phase4-console-demo.md](phase4-console-demo.md)。

**出口商偏好**（`PUT /api/agent/cases/:id/preferences`）：`min_acceptable_issue_price`（0–1）、`payout_speed_preference`、`target_financing_amount`。接入流水线据此选速度，价格达不到底价时挂起复核；之后的自动改价低于底价时转为审批。

### 合约

原六份协议合约源码是 v2（见 [contracts.md](./contracts.md) §0），测试网上已于 2026-10-12 重新部署为 v2；独立 AgentDecisionLog 于 2026-10-15 部署。原六份当前不改、不重部署。以下仅记录未来另行明确授权协议升级后的流程，不属于本轮 Phase 7 授权范围：

```bash
cd hardhat
npm ci
npm test                       # 先确认测试通过
npm run deploy:all             # 仅未来单独授权协议重部署后执行；需要已配置 owner 与测试网 INJ
cd .. && npm run verify:bytecode -- --strict   # 确认链上代码与源码一致
```

重新部署后，部署脚本更新 `public/chain-config.json`；按上表完成明确授权的角色配置，再运行 `npm run verify:wave-b -- --dry-run` 只读复核。Wave B 默认不读私钥、不发交易，复用已登记的货物/活跃池，同一已处理报告返回 no-op；实际广播需单独获得用户同意后用 `--confirm`。新 attempt 证据不覆盖历史文件，细节见 [wave-b.md](wave-b.md)。现有六个合约默认不改/不重部署；它们**没有认购付款环节，不要放入真实资金**。

### 通用

- 永远不要提交 `.env`，私钥只放在部署平台的密钥管理里；
- 测试网私钥与主网私钥严格分开；
- 对外公开时仍建议在 Nginx 层再加一层请求频率限制：应用内置的限流是按进程内存计数的，多实例之间不共享。

---

## ✅ 部署后验证

```bash
BASE=https://your-domain.com     # 本地为 http://localhost:3000

curl $BASE/api/health                         # 健康检查
curl $BASE/api/llm/status                     # {"ok":true,"enabled":true,"configured":...}，不会返回 key
curl $BASE/api/cases                          # 贸易案例列表
curl -X POST $BASE/api/pricing/quote \
  -H "Content-Type: application/json" -d '{}' # 用默认演示案例生成定价报价
curl -sI $BASE/ | grep -i content-security     # 应该能看到 CSP
```

页面上再确认：

- [ ] 首页、样式、图片正常加载，控制台无报错（也没有被 CSP 拦截的请求）
- [ ] 可以切换贸易案例并看到 AI 定价结果
- [ ] 钱包（MetaMask / Keplr）可以连接，并切换到 Injective 测试网（chainId 1439）
- [ ] 模式开关：没有 `AGENTBL_ADMIN_TOKEN` 时，Live 已配置的情况下应拒绝切换

---

## 🐛 常见问题

| 症状 | 排查 |
|---|---|
| AI 结果是固定数值 | 没有配置 LLM / 行情 key，正在使用离线回退数据，属正常行为 |
| AI 助手只做关键词搜索 | `/api/llm/status` 返回 `configured:false`（没配 key）或 `enabled:false`（`LLM_PROXY_ENABLED=false`）；已配置但点了没反应、回答为空或被截断：推理型模型（GLM、DeepSeek-R1 等）的隐藏思考也计入 `max_tokens`，默认 2048 的上限可能被思考用完（响应里的 `finish_reason` 是 `length`），设置 `LLM_MAX_TOKENS_CAP`（范围 256–32768；免费网关可设 `0` 表示不设上限，上游超时、并发和限流仍然生效）和 `LLM_REASONING_EFFORT=high` |
| 环境变量不生效 | 确认 `.env` 在项目根目录，或已通过 `--env-file` / 平台面板传入；变量名区分大小写 |
| Docker 中写运行时目录报只读错误 | 确认 `/app/data/runtime` 挂载为可写的命名卷；根文件系统本身是只读的 |
| 所有用户被限流 / 限流不生效 | 反向代理后面需要设置 `TRUST_PROXY=1`，并让代理传递 `X-Forwarded-For` |
| 页面一直提示输入管理员令牌 | 模式切换需要 `AGENTBL_ADMIN_TOKEN`（≥ 16 字符）；令牌错误会返回 401 |
| 浏览器控制台出现 CSP 拦截 | 检查是否加载了新的第三方脚本/域名，并调整 `src/app/security.js` |
| 钱包交易失败 | 确认钱包在 Injective 测试网、账户有测试 INJ（[水龙头](https://testnet.faucet.injective.network/)），且 `chain-config.json` 中的合约地址是最新部署 |
| 链上合约行为与文档不一致 | 运行 `npm run verify:bytecode`：链上合约可能落后于源码，需要重新部署 |

## Phase 5 audit and manual smoke

Agent decisions, event queue and approvals contain authenticated AES-256-GCM operational snapshots. Keep the generated `*.key` files with their journals when backing up the private runtime volume; request 0600/Windows ACL restrictions. Missing keys or mismatched audit projections fail closed. Public decisions, activity and traces are redacted; uploads remain in the private `uploads/` directory for review. Never expose the runtime volume as static web content.

`AGENT_MAX_DECISIONS` and `AGENT_RETENTION_DAYS` apply on scheduler ticks to finished audit records, including rotated logs. Pending approvals, owner signatures, broadcasts and dead letters remain available for recovery. A retained SSE sequence checkpoint prevents cursor reuse after cleanup.

The fixed testnet smoke proposal endpoint is disabled unless `AGENT_LIVE_SMOKE_ENABLED=true`, Live/propose mode and admin authorization are in effect. The CLI defaults to read-only. Authorize a specific run before `--run-id <stable-id> --confirm`; verify each transaction and keep every attempt JSON. Lifecycle owner steps continue through the existing one-step CLI and wallet confirmations. See [Phase 5](phase5-security-replay.md) and [security matrix](agent-security-matrix.md).
## Phase 7 独立决策锚定

2026-10-15 已按用户明确授权完成单版本的三笔测试网部署/初始化，逐笔回执、事件和七份注册合约字节码核验通过；见 [实链证据](evidence/phase7-live-deployment-verification.json)。首次批次及后台启用仍待单独授权，当前批次为 0。

`npm --prefix hardhat run deploy:agent-log` 默认仅输出计划，零广播；真实部署前按 [实现规划 §16](agent-implementation-plan.md#16-需要用户亲自完成或确认的事项) 获取单独授权。先通过 `npm run agent:anchor-plan -- --out <new-plan.json>` 准备版本及交易计划；运行中服务器的公开版本对象可用 `--version-file` 提供。单版本为部署、注册版本、授权既有 pricing 地址三笔，历史版本可能增加注册数。

部署由本机 owner 使用已审阅的 `AGENT_ANCHOR_DEPLOY_PLAN` 和单次 `AGENT_ANCHOR_DEPLOY_CONFIRM=true` 执行；不运行 deploy:all，不更改原有六份合约。全部初始化确认后合并新地址/ABI/部署证据；重复运行恢复原哈希，不重复部署。`verify:bytecode` 自动纳入注册表中的新地址。`AGENT_ANCHOR_ENABLED` 默认 false，启用后台锚定及首次广播也需明确授权。当前发布 preflight 为 71 项。API、只读校验 CLI、备份/未知广播处理和证据局限见 [Phase 7 指南](phase7-decision-anchoring.md)。

本机 WSL 的 Hardhat `.bin` 包装器实际调用 Windows Node；临时计划/确认变量需通过 WSLENV 显式传入并先核对计划文件 SHA-256，详见 [真实部署过程](phase7-decision-anchoring.md#真实部署与初始化2026-10-15-utc)。本次没有修改依赖或持续设置确认变量。

Phase 7 验收固定 Node 测试并发为 4，参数放在文件列表之前；coverage 的 88/72/86 门槛不变。完整 coverage、评测和 preflight 串行运行，避免资源竞争造成假超时。preflight 中完整 Node 套件的进程上限为 10 分钟，其余命令仍为 3 分钟；断言及完整执行检查不变。
