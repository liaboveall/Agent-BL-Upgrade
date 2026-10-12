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
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT` / `AZURE_OPENAI_API_KEY` | 也可改用 Azure OpenAI 作为 LLM 提供方 |
| `METALPRICE_API_KEY` / `ALPHAVANTAGE_API_KEY` | 实时铜价 |
| `COMTRADE_PRIMARY_KEY` | UN Comtrade 历史成交价 |
| `XAPI_KEY` | 世界风险情报（新闻 / 社交 / 预测市场） |
| `INJECTIVE_RPC_URL` | Injective 测试网 RPC（有默认值） |
| `X402_MODE=live`、`X402_FACILITATOR_URL`、`X402_PAY_TO`、`X402_PUBLIC_BASE_URL` | Live 模式的 x402 付费情报，详见 [x402-integration.md](./x402-integration.md) |
| `PAYMENT_ATTESTOR_PRIVATE_KEY`、`PRICING_UPDATER_PRIVATE_KEY`、`SIGNER_KEYS_STRICT` | 服务器按角色使用的最小权限签名密钥，见“链上角色与密钥” |

前端连接的合约地址**不走环境变量**，而是读取 [`public/chain-config.json`](../public/chain-config.json)。重新部署合约后，部署脚本会自动更新这个文件（也可以用 `npm run migrate:chain-config`）。

### 运行时数据

服务会把 x402 收据、报告缓存、Agent 决策日志、Mystery Voyage 揭晓记录写入 `AGENTBL_RUNTIME_DIR`（默认 `data/runtime/`，已在 `.gitignore` 中忽略）。生产环境要保证这个目录**可写且持久**，否则重启后这些记录会丢失。池子 / 认购数据只在内存里，重启即清空。

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

AI 助手通过同源接口 `/api/llm/chat` 调用 LLM：key 留在服务器，服务器决定模型、限制 `max_tokens`（≤ 2048）、消息数和工具数，并发上限由 `LLM_PROXY_MAX_CONCURRENCY` 控制（默认 4），每个客户端每分钟的调用数由 `LLM_RATE_LIMIT_PER_MIN` 控制（默认 30）。

但这个接口**本身没有登录**：任何能访问站点的人都能在限流范围内消耗你的 LLM 额度。公开部署时请：

1. 在 LLM 提供方的控制台给这个 key 设置**消费上限**；
2. 或者不想承担这个风险时设置 `LLM_PROXY_ENABLED=false`，AI 助手会退回到关键词搜索；
3. 确保设置了正确的 `TRUST_PROXY`，否则所有用户会共用同一个限流桶（或被伪造 IP 绕过）。

### 运行模式与 Live

- 在 `.env` 里设置 `AGENTBL_ADMIN_TOKEN`；Live 模式的切换请求需要带上它。页面上点击模式开关时会提示输入，令牌只保存在当前标签页的 `sessionStorage`；
- Live 需要 `X402_MODE=live`、`X402_FACILITATOR_URL`（HTTPS）和 `X402_PAY_TO`；如果服务在代理后面，还要设置 `X402_PUBLIC_BASE_URL`。收款地址和付款钱包都需要有测试网 USDC / INJ。

### 链上角色与密钥

服务器不再用合约 owner 密钥签名，而是按角色使用独立的、只授权一个功能的密钥：

| 角色 | 环境变量 | 在链上授权 |
|---|---|---|
| 写入 `PaymentOracle` 付款证明 | `PAYMENT_ATTESTOR_PRIVATE_KEY` | `PaymentOracle.setAttestor(<地址>, true)` |
| 向 `RiskPricingOracle` 推送价格（MCP 工具） | `PRICING_UPDATER_PRIVATE_KEY` | `RiskPricingOracle.setUpdater(<地址>, true)` |

`DEPLOYER_PRIVATE_KEY`（合约 owner）只在你运行 `cd hardhat && npm run deploy:all`（或 `deploy:protocol`、`deploy:payment-oracle`）的机器上需要，**不要放到对公网的服务器上**。设置 `SIGNER_KEYS_STRICT=true` 后，上面两个角色不会再回退到 owner 密钥。

### 合约

仓库里的合约源码是 v2（见 [contracts.md](./contracts.md) §0），测试网上已于 2026-10-12 重新部署为 v2。以后再改合约源码，需要重新部署才会生效：

```bash
cd hardhat
npm ci
npm test                       # 先确认测试通过
npm run deploy:all             # 需要 .env 里持有测试网 INJ 的 DEPLOYER_PRIVATE_KEY
cd .. && npm run verify:bytecode -- --strict   # 确认链上代码与源码一致
```

重新部署后，部署脚本会自动更新 `public/chain-config.json`；然后按上表给两个新密钥授权，并重新运行 `npm run verify:wave-b` 之类的链上验证。合约是演示级别，**没有认购的付款环节，不要放入真实资金**。

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
| AI 助手只做关键词搜索 | `/api/llm/status` 返回 `configured:false`（没配 key）或 `enabled:false`（`LLM_PROXY_ENABLED=false`） |
| 环境变量不生效 | 确认 `.env` 在项目根目录，或已通过 `--env-file` / 平台面板传入；变量名区分大小写 |
| Docker 中写运行时目录报只读错误 | 确认 `/app/data/runtime` 挂载为可写的命名卷；根文件系统本身是只读的 |
| 所有用户被限流 / 限流不生效 | 反向代理后面需要设置 `TRUST_PROXY=1`，并让代理传递 `X-Forwarded-For` |
| 页面一直提示输入管理员令牌 | 模式切换需要 `AGENTBL_ADMIN_TOKEN`（≥ 16 字符）；令牌错误会返回 401 |
| 浏览器控制台出现 CSP 拦截 | 检查是否加载了新的第三方脚本/域名，并调整 `src/app/security.js` |
| 钱包交易失败 | 确认钱包在 Injective 测试网、账户有测试 INJ（[水龙头](https://testnet.faucet.injective.network/)），且 `chain-config.json` 中的合约地址是最新部署 |
| 链上合约行为与文档不一致 | 运行 `npm run verify:bytecode`：链上合约可能落后于源码，需要重新部署 |
