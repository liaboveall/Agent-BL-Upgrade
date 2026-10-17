# 2026-10-17 独立评估证据

基线：`586785811842ed3ca3140563cf452d27e65d06ee`。主报告：`docs/project-review-2026-10-17.md`。

## 证据边界

- 浏览器与 API 使用本次专属 `127.0.0.1:4177` / `4178`，runtime 位于 `/tmp/agentbl-review-20261017/`；没有操作用户原有业务 runtime。
- 服务器为 `DEMO_MODE=true`、`X402_MODE=demo`、`REAL_DATA=off`、`AGENT_ANCHOR_ENABLED=false`。`NODE_TEST_CONTEXT=review` 只用于隔离服务进程以阻止加载 `.env`，不可用于 Node 测试 runner。
- 钱包脚本注入拒绝 `eth_sendTransaction` 的桩；捕获交易请求不等于广播。没有钱包签名、真实支付或链上写入。
- 合约探针仅部署在 Hardhat 本地测试网络。需要 owner 的步骤使用本地测试 signer。
- `bytecode.json` 与 `live-data.json` 是单独执行的公开只读请求。
- 所有上传文件均来自项目已有虚构样本；隐私测试标记是虚构字符串。

## 文件索引

| 文件 | 内容 |
|---|---|
| `protocol-probe.mjs` / `protocol-probes.json` | 四组独立协议观察：重复经济资产、运输阶段回退、满额后无法发运、极小回款解押 |
| `api-probes.json` | 亏损报价仍开放、上传解析字段进入匿名目录 |
| `data-pricing-probes.json` | 低利润纯函数、过期行情、空波高、风险不降级 |
| `browser-baseline.json` | 四页中文文本、桌面尺寸与 axe 对比度结果 |
| `browser-flows.json` | 案件切换延迟、偏好串用、满额仍开放、额外 1280px 检查 |
| `browser-wallet.json` | DEMO 下到达钱包发送方法；桩拒绝发送，`txBroadcast=false` |
| `browser-e2e.json` | 英文四页、Copilot、x402 模拟报告、Demo 场景播放与第一项付款审批 |
| `browser-finish.json` | 第二项独立 SETTLE 审批、Repaid 镜像、Mystery 证明与一份 Passport |
| `bytecode.json` | 七份测试网合约与本地字节码一致 |
| `live-data.json` | 本次公开行情/航线来源和观测时间 |
| `audit-prod.json` | 本次 npm 生产依赖审计结果 |
| `logs/` | 构建、静态检查、应用/合约测试、评测与环境失败日志 |
| `screenshots/` | 页面及关键反例截图；图片内容表示实际界面语言 |
| `session-scripts/*.mjs.txt` | 本次实际运行脚本的原样快照，包含会话临时路径；不是通用 CI 工具 |
| `manifest.json` | 审查环境、结果边界和文件 SHA-256 清单 |

`browser-flows.json` 的原始 harness 将切换语言后的页面误命名为 `englishPages`，实际切换后是中文。归档时只将这个键改名为 `afterLanguageTogglePages` 并增加说明，保留原始文本和观察；没有把这些截图冒充英文。真正英文页面来自 `browser-e2e.json`，中文基线来自 `browser-baseline.json`。

## 已运行命令

项目根目录：

```bash
npm run build
npm run lint
npm run check
npm run test:contracts
NODE_TEST_CONTEXT=review REAL_DATA=off npm run eval:agent -- --check
npm audit --omit=dev --json
node scripts/verify-bytecode.mjs --strict --json
```

当前安装的是 Windows 原生依赖，完整应用覆盖率使用以下命令成功：

```bash
'/mnt/c/Program Files/nodejs/node.exe' --test --test-concurrency=4 \
  --experimental-test-coverage '--test-coverage-include=src/**' \
  --test-coverage-lines=88 --test-coverage-branches=72 \
  --test-coverage-functions=86 'tests/*.test.js'
```

`logs/node-tests.log` 是 Linux Node 遇到缺少 Rolldown 原生绑定的失败尝试；`logs/node-tests-windows.log` 是成功的 1292 项结果。原生依赖安装平台和执行平台必须匹配，不建议混用同一套 `node_modules`。

协议探针从项目 `hardhat/` 目录运行：

```bash
./node_modules/.bin/hardhat test mocha --no-compile \
  ../docs/evidence/review-2026-10-17/protocol-probe.mjs
```

本次使用已有编译产物与本地测试网络。`protocol-probes-extended.log` 为四项最终结果；较早日志记录平台依赖或调用路径错误，以及扩展前的运行。探针会覆盖旁边的结果 JSON；重跑前应另存本次证据。

**这些探针是观察脚本：四项运行成功表示反例被执行并采集，不表示协议满足正确性要求。** 应在正式修复中把观察改为要求正确行为的回归断言，而不是把它们直接当作绿色安全测试。

浏览器脚本依赖本次临时安装的 Playwright、axe 和本地 Chromium。快照保留具体路径以便核对本次执行；复现时需使用新的隔离 Demo runtime，并调整本机路径和端口。不要将写入型 Demo 探针直接指向 Live 或用户现有服务。

远程 CI、当前 Docker、真实 LLM/OCR/外部合规、真实 USDC 生命周期、独立灾备和人工设备验收均不属于本次通过项。
