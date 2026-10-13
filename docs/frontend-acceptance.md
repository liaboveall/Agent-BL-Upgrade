# 全站前端验收（WP4.6）

2026-10-13：WP4.6 的本地实现与验收完成。覆盖市场和持仓、铸造和真实文本上传、Agent 控制台，以及航程/x402、Mystery、独立认购确认、护照分享、Copilot 和决策详情。当时的下一批 WP3.6/WP3.8 已在后续 P1 完成本地验收，见 [copilot.md](copilot.md)；余项仍按实施规划安排。

## 已修复的问题

| 问题 | 当前行为 |
|---|---|
| 自定义下拉框隐藏原生 select，生成的 div 无键盘选择和读屏语义 | 移除替换层，使用已有主题样式的原生 select；标签和选中值保留 |
| 390px 上传区域仍跨两列，内容被 overflow 隐藏 | 使用 `minmax(0, 1fr)` 和 `grid-column: 1 / -1`；检查元素边界，不能用裁切冒充适配 |
| 悬浮活动终端覆盖主内容 | 改为页尾原生 details/summary，默认收起，Enter 可展开；活动仍来自服务器 |
| 项目详情、护照分享、航程提示溢出窄屏 | 修正弹窗内部网格、输入宽度和长文本；提示在航程轨道内展示 |
| 导航缺少选中状态、面板关联和方向键 | tab/tabpanel 关联；方向键与 Home/End 切换。到账速度使用单选组语义 |
| 决策行内嵌按钮，抽屉关闭/刷新后焦点丢失 | 行内操作独立；抽屉和 Copilot 使用原生 dialog，Tab 循环，Escape 关闭并恢复焦点 |
| 提交事件禁用按钮导致焦点离开；SSE/轮询重建控件 | aria-disabled 等待态与跨重绘的请求保护；按稳定控件标识恢复同步重绘中的焦点 |
| 时间线重绘重复播报历史，切换语言后播报仍用旧语言 | 稳定的 polite 区域只播报新决策/状态变化，含决策标识；相同历史保持安静，文案随语言更新 |
| 英文案例选项、贸易标签或可访问标签保留中文 | 全站翻译键扫描包括所有前端模块和 `data-i18n-aria`；展示层转换已知贸易标签，服务器结果与证据哈希保持原样 |
| 拒绝审批的 prompt 被取消后仍发送拒绝请求 | Cancel 保留待审批状态，不发送拒绝动作 |

焦点轮廓、跳到主要内容入口和 reduced-motion 规则适用于全站。钱包菜单方向键只移动焦点，不连接钱包或触发签名；异步 Copilot 结果不会把已关闭窗口的焦点拉回输入框。

## 浏览器证据

本机 Edge **155.0.4283.45**，**1440×1000 / 390×844**，**中文 / 英文**：每个组合检查 10 个页面或弹窗状态，共 **40** 个组合、**255** 项检查。使用真实本地服务器和隔离的 Demo 数据目录；文本上传读取仓库提单、发票和保单；Mystery 走实际的本地 402 → 签名 → 模拟结算 → 揭晓 → proof 流程。

检查包含：横向元素边界（含字段详情和打开的航程提示）、控件名称/嵌套、翻译键与英文混入中文、导航/到账速度/钱包菜单键盘操作、Tab/Shift+Tab/Escape、实际 SSE 重绘后的焦点、轮询不重复播报、proof 篡改后禁用认购/恢复、独立确认和 reduced-motion。控件必须真的被 SSE 重建，不能只在刷新前检查焦点。

最终记录：[agent-phase4-browser.json](evidence/agent-phase4-browser.json)。页面脚本错误 **0**，非预期本地 HTTP 错误 **0**；**4** 个 HTTP 402 为付费端点的正常 challenge。

第一轮完整验收在事件提交后的焦点检查失败；[修复前记录](evidence/agent-phase4-browser-before-fix.json)保留 `passed: false` 和当时只完成的 3 个组合，不能作为全站通过证据。全量回归还发现旧只读助手接口的两个中文文案不兼容，已恢复原措辞，没有放松原测试。

独立 CLI 操作也确认了：点击可见“浏览文件”按钮后实际打开文件选择器并上传三份 fixture；铜场景通过本地 API 准备待审批方案后，实际打开拒绝 prompt 并 Cancel，原审批仍为 PENDING。API 准备场景不等于前端“一键全流程演示”（WP4.5）。

截图：[桌面英文](evidence/agent-phase4-desktop-en.png)、[单证](evidence/agent-phase4-mobile-documents-en.png)、[航程](evidence/agent-phase4-mobile-voyage-en.png)、[盲盒](evidence/agent-phase4-mobile-mystery-zh.png)、[护照分享](evidence/agent-phase4-mobile-passport-en.png)、[Copilot](evidence/agent-phase4-mobile-copilot-en.png)、[决策详情](evidence/agent-phase4-mobile-decision-zh.png)。

## 工程检查与复现

最终命令计数和工作区代码摘要：[agent-phase4-local.json](evidence/agent-phase4-local.json)；发布闸门：[agent-phase4-preflight.json](evidence/agent-phase4-preflight.json)。

`npm test` / 覆盖率均 **890/890**、零跳过/取消；lines **94.26%** / branches **83.01%** / functions **91.61%**（覆盖率范围 `src/**`，前端另有行为测试和浏览器矩阵）。lint 零警告、check 通过；preflight **56 PASS / 0 WARN / 5 SKIP / 0 FAIL**，含 **74** 个合约测试。5 个 SKIP 为 Demo 下的 Live 专属项。

```text
npm run lint
npm test
npm run check
npm run test:coverage
npm run preflight -- --report docs/evidence/agent-phase4-preflight.json
```

浏览器脚本：[scripts/ui-acceptance.playwright.js](../scripts/ui-acceptance.playwright.js)。需要本机 playwright-cli 和 Edge，不加入应用/CI 依赖。脚本会重置 Demo、模拟认购、上传单证并购买 Demo 报告，应针对隔离数据目录运行。

从仓库根目录用 Windows PowerShell 启动离线服务器，跳过本机 `.env`：

```powershell
$env:NODE_TEST_CONTEXT='wp46-offline'
$env:DEMO_MODE='true'
$env:LLM_PROXY_ENABLED='false'
$env:AGENT_VALUATION_LLM='false'
$env:AGENTBL_RUNTIME_DIR=Join-Path $env:TEMP ('agentbl-ui-' + [guid]::NewGuid())
$env:HOST='127.0.0.1'
$env:PORT='3000'
node src/app/server.js
```

另一个终端从仓库根目录执行：

```powershell
playwright-cli -s=agentbl-ui open http://127.0.0.1:3000 --browser=msedge
playwright-cli -s=agentbl-ui --raw run-code --filename=scripts/ui-acceptance.playwright.js
playwright-cli -s=agentbl-ui close
```

脚本写入 `docs/evidence/agent-phase4-*.png`；复验前如需保留旧截图，先另存。验证完停止自己启动的服务器。CLI 对文件选择器和 JavaScript prompt 会单独交还控制，所以完整脚本直接提交 fixture 文件；选择器/取消 prompt 的补充检查使用 `upload` / `dialog-dismiss`。

## 证据边界与提交建议

没有真实 LLM 请求、链上写入或真实资金移动。浏览器可能只读查询公开测试网部署信息；这不构成 Live 钱包/交易验收。源单据、原始证据 JSON、历史用户消息和提供方原文保持原内容；翻译检查针对 UI 和已知 fixture 展示标签，不声称自动翻译任意贸易材料。

Codex 内置浏览器面板返回 **queued**，实际交互在独立 Edge/Playwright 会话完成。这些自动化与 DOM 语义检查不等于用户人工试用、真实读屏器、实体移动设备验收或 WCAG 认证。没有新增部署、提交、推送或远端 CI 结论。

建议分组：① `fix(frontend): preserve keyboard access and responsive layouts`（前端、回归测试、browser runner）；② `docs: record WP4.6 frontend acceptance and P1 handoff`（状态、说明、本地证据）。本次保留未提交改动，等待用户另行指示提交/推送。
