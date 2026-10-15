# Phase 4：控制台、证据联动与全流程演示

2026-10-15，Phase 4 的六个工作包已完成本地实现与自动化验证。当前工作区保留此前 WP2.x 的未提交改动；本批未提交、未推送。内置桌面控制在初始化时返回 `sandboxCwd is not a local file URI`，本机 Chromium 的结果与用户人工验收分开记录。

## 工作包与实际行为

| 工作包 | 本地交付 |
|---|---|
| WP4.1 控制台 | 运行状态、管理员控制、真实决策/来源/执行记录、审批、追踪、证据与模型用量；从决策打开市场及历史价格瀑布图。模型用量只保存提供方实际返回的数值，缺失值明确说明未记录。跨阶段的决策重放功能仍归 WP5.5。 |
| WP4.2 单证管理 | 上传实际文本/PDF/图片内容，字段及来源、作业步骤和 SSE；修正补件产生新作业，旧证据保留；模型及扫描件边界见 document-extraction.md。 |
| WP4.3 持仓 | 市场和 Copilot 使用同一服务器持仓；来源、当前池状态/风险/价格和关联决策。此包的持仓为 Demo 模拟记录，Live 钱包持仓不在此范围。 |
| WP4.4 ID 贯通 | 时间线、市场、瀑布图、x402 面板和持仓共享保存的 `decision_id / quote_hash / report_ids / tx_hashes`。点击其他案例的决策也会同步所选案例、池高亮及历史报价。 |
| WP4.5 演示 | 后台播放、四个场景、速度选择、逐步高亮、键盘停止、页面刷新后恢复查看进度；完整铜货场景从三份真实样例文件开始，经模拟认购、离港、改价、暂停、恢复、到港，再进入付款审批与独立结算审批。 |
| WP4.6 适配 | 新文案中英齐全、1440px/390px、长证据编号换行、窄屏瀑布图、键盘/焦点及 polite 进度播报；修复异步弹窗返回入口和跨语言缓存面板，遵守 reduced-motion。 |

## 从界面演示

1. 进入 Demo 的 Agent 控制台，选择“铜货全流程：单证接入至结算审批”和播放速度，点击“启动演示”。Demo 自主级别需要为 auto。
2. 步骤和决策来自同一服务器运行时。点击决策可查看保存的报价，再打开对应市场或瀑布图。市场显示服务器当前池状态，历史瀑布图明确标注只供查看；认购使用当前有效报价。
3. 10 步播放结束后，先批准 `RECORD_PAYMENT`；服务器验证流程完成后另行提出 `SETTLE`，再次批准才完成模拟结算。合约语义是记录还款，不代表自动分配资金。
4. 随时“停止播放”：等待当前已提交步骤收尾后停止，保留其日志、作业、审批和模拟持仓。普通播放不会清理历史；重新从干净状态演示要显式使用“重置 Demo”。

## 接口与恢复边界

```http
POST /api/agent/demo/run
Content-Type: application/json

{"scenario":"copper-lifecycle","speed":2}
```

- 返回 202 和 `run`，后台逐步推进；`GET /api/agent/demo/run` 读取当前状态；`POST /api/agent/demo/stop {}` 停止并等待当前步骤收尾。状态为 idle / starting / running / completed / stopped / failed；completed 表示播放结束，审批结果以独立审批/决策记录为准。
- 场景：`copper-lifecycle`（默认）、`copper-typhoon`、`warcrisis-hormuz`、`insurance-gap`。`speed` 是 0.25–10 的数字，只影响真实播放间隔，不影响事件的虚拟时间、报价或幂等身份。界面提供 0.5/1/2/5/10 倍速。
- Demo 未配置管理员令牌时可直接演示；配置后写接口需要令牌。Live 禁止播放；模式或 generation 变化会停止旧任务。手动场景接口与后台播放互斥，同一时间只有一个步骤在执行。
- 事件、上传作业和模拟认购分别幂等；重复播放不会重复创建。服务器重启不会自动恢复计时器，已有持久化决策和审批仍按原运行时恢复规则处理。播放状态本身是进程内状态。
- `GET /api/agent/references` 返回当前模式/generation 的各案例最新决策、其引用以及当前池报价。历史决策详情仍可读取；没有保存完整报价的旧记录不提供历史瀑布图按钮，直接打开定价页也会明确说明图表显示当前报价。
- 报告编号只来自该报价实际引用的已验证付费报告。报告付款交易和决策执行交易分别标明；Demo 的 `demo:` / `demo://receipt/` 不会被推算成链上交易或浏览器链接。缺失报告和交易明确显示为空。
- 演示单证使用确定性解析、估值和离线世界风险，不读取开发者密钥、不访问真实 LLM/RPC、不发送交易。普通上传的可选模型配置仍按原功能生效。

## 验证与复现

新增 11 项行为测试覆盖完整单证/审批故事、重复播放、并发与停止、模式切换、无效输入/管理员保护、速度不改变承诺、历史报价保存、跨页面引用及模型用量脱敏。全量覆盖率执行 **1126/1126**；行 **94.70%**、分支 **84.03%**、函数 **92.25%**，均高于 88/72/86 门槛。lint 和仓库完整性检查通过。

新流程浏览器验收 **107/107**，四个中英/1440px/390px 组合，零页面脚本错误。报告：[phase4-browser-1792003967170.json](evidence/phase4-browser-1792003967170.json)。全站 40 个页面/弹窗组合另行回归通过 255/255，发布总闸门 56 PASS / 0 WARN / 5 Live SKIP / 0 FAIL（含 74 项合约测试）；汇总在 [phase4-local.json](evidence/phase4-local.json)；失败的早期测试和浏览器尝试均保留。

```bash
node --test tests/phase4Workflow.test.js
npm run lint
npm run test:coverage
npm run check
node scripts/phase4-acceptance-server.mjs
# 使用上一步打印的 loopback URL；Playwright 与 Chromium 可使用已安装路径
node scripts/phase4-acceptance-runner.mjs --url http://127.0.0.1:<port> --playwright-module <playwright/index.mjs> --browser-executable <chromium>
node scripts/phase4-acceptance-runner.mjs --all-pages --url http://127.0.0.1:<port> --playwright-module <playwright/index.mjs> --browser-executable <chromium>
```

本地浏览器和假提供方验证不替代真实 LLM 支持/质量、钱包/owner/USDC 交易、真实 RPC 长时间运行、实体手机或人工读屏器验收。上述真实链上操作继续按实施规划 §16 逐笔授权。下一阶段为 Phase 5 尚未完成的 P1 工作包，含 WP5.2/5.3/5.5/5.6/5.7/5.9。

建议提交分组：① 保存报价和统一证据引用；② 安全后台演示、完整单证场景及模型用量；③ 控制台/市场/持仓联动和适配；④ 行为测试、浏览器脚本、文档及验收记录。与此前共享文件的改动需按实际 diff 分组。
