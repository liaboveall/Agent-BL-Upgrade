# 单证抽取与人工复核（WP2.2）

2026-10-14（开发始于 2026-10-13）：PDF 文本层、可选图片视觉抽取、缺字段的文本模型补全和中文仓单已接入现有上传作业、九步审单与修正补件流程。接收文件不代表核验通过；扫描件、模型失败、字段冲突、疑似注入或无法定价都会保留原因并进入 `HOLD_FOR_REVIEW`。

## 支持的路径

| 输入 | 抽取与来源 | 复核条件 |
|---|---|---|
| 文本 / Markdown | 确定性标签、表格、数量和日期规则；字段有来源行号 | 必填项缺失、低置信度、冲突或注入 |
| PDF | 仅读取文本层；来源为 `pdf-text`，字段保留页码及页内行号 | 扫描页/无文本页、损坏、加密、超过限制或字段缺失 |
| PNG / JPEG | `AGENT_VISION_ENABLED=true` 且已配置兼容模型时，发送内联图片并要求严格 JSON；来源为 `llm-vision` | 始终需要人工核对，文档和每个字段的置信度最多 0.75 |
| 缺字段的文本 | `AGENT_DOCUMENT_LLM=true` 时才调用文本模型，填充有原文证据的字段 | 采用模型补字段、模型失败、无证据或与确定性结果冲突 |
| 中文仓单 / 人民币发票 | `WAREHOUSE_RECEIPT` 独立结构；仓单号、货权凭证、仓库、吨数、HS、CNY 货值 | 比对仓单引用、数量、HS、币种与货值；非 USD 发票挂起汇率及融资复核 |

图片和文本模型开关**默认都是 false**。开启对应开关后，上传内容会发送给服务器已配置的 LLM；凭据只留在服务器。未配置提供方、提供方不支持图片或 JSON schema、网络失败、超时或模型返回工具调用时，保留失败原因并复核，不模拟成功。原来的 `AGENT_VALUATION_LLM` 只控制后续估值步骤，不能替代这两个开关。

模型没有工具，也不接受价格、风险动作、权限、钱包地址、付款目标或链配置作为可写字段。文本先以中英规则、零宽字符、常见西里尔同形字、钱包及 `payTo` 模式筛查；整批可读单证在第一条模型请求前筛查。命中时阻止模型调用，后续估值强制使用确定性路径。图片内容无法在首次视觉请求前逐字筛查，因此使用隔离的无工具提示、输出筛查和强制人工复核。模型输出不会改变执行权限、支付地址或定价规则。

文本传给模型前使用共用 sanitizer，放在不可信数据定界块内；字段必须通过 zod 类型、日期和范围校验，并提供确实出现在原文中的证据。数字还要与证据中的写明数字一致。确定性值优先，冲突记 `EXTRACTION_CONFLICT`；无证据值忽略并记录 `MODEL_FIELD_UNSUPPORTED`。视觉转录本身仍是模型输出，不能把转录中的“证据”当成对原图的独立核验。

人民币金额保存在 `total_amount_cny` / `declared_value_cny`，不填入美元字段，不推测汇率；仓单保存在 `warehouse_receipt`，不伪造海运提单。铜和原油的虚构保单在 `data/uploads` 中复用原有样例，没有再次编造真实保险凭证。

## PDF 依赖与运行边界

锁定 **unpdf 1.7.0**（MIT；内含 PDF.js 5.6.205），解包体积 **2,029,109 bytes**，没有运行时依赖；可选 canvas peer 没有安装。选型核对了[版本清单](https://github.com/unjs/unpdf/blob/v1.7.0/package.json)和[该版本的 API 与兼容说明](https://github.com/unjs/unpdf/blob/v1.7.0/README.md)。1.8.1 的声明要求 Node >=22，因此没有用于仍承诺 Node 20.11 的应用。

本地实测 Node **20.11.1 / 22.23.3 / 24.21.0** 的 17 项抽取测试全部通过；另在 Alpine **3.22.0 / Node 22.23.2** 中运行同一测试，17/17 通过。Alpine 使用校验 SHA-256 的官方 minirootfs、独立挂载和只读代码目录；不是 Docker 镜像发布验收。完整 Docker 与远端 CI 状态另行报告。`npm audit --omit=dev` 当前为零漏洞；审计数据库的通过不能证明 PDF.js 的绝对安全。

每个 PDF 用独立、可终止的 Worker 解析，不继承宿主 CLI flags 或环境凭据；限制为 **30 页、200,000 个文本字符、10 秒**，Worker 的 V8 old/young generation 限额分别为 192/32 MiB（不等同于整个进程的 RSS 上限）。逐页抽取并清理资源，不渲染图片、不执行嵌入脚本、不加载远程字体或 CMap。worker 超时会被终止，不会继续占用 HTTP 事件循环。损坏/加密/超限有独立错误码；无文本层是 `OCR_REQUIRED`。混合 PDF 中任何无可读文本页也会要求复核，不能因为另一页完整就放行。

布局重建支持普通行和有横向间隔的表格列；复杂排版、旋转阅读顺序、缺少字体映射、文本层与扫描图像不一致不保证正确。页内行号指重建文本行，可能和 PDF 阅读器的视觉换行不同。置信度是规则分数，没有被解释成现实准确率。

## 本地验收结果

最终应用测试 **943/943**；覆盖率 **lines 94.11% / branches 83.11% / functions 91.60%**，高于 88/72/86 门槛；lint 零警告，仓库 check 通过。61 项 preflight 为 **56 PASS / 0 WARN / 5 SKIP / 0 FAIL**，其中合约 74 项通过，Live 五项明确跳过。浏览器 **118** 项通过，页面脚本错误为零。截图复查发现步骤状态漏翻译，保留原截图和 DOM 证据，补齐状态/缺字段翻译并扩大原先过窄的翻译检查。

## 复现与证据

```bash
node --test tests/documentExtraction.test.js tests/documentParser.test.js tests/documentConsistency.test.js tests/agentIngestPipeline.test.js
npm run lint
npm run check
npm run test:coverage
```

运行时兼容检查：`npm exec --yes --package=node@20.11.1 -- node --test tests/documentExtraction.test.js`（22/24 同理）。Alpine 可用 `python3 scripts/document-extraction-alpine-check.py` 复验，需要 Linux、Python 3.12+、bwrap 和网络；自动校验官方 rootfs、安装 Node、只读挂载源码，结束后删除临时 rootfs。

浏览器使用独立、无需凭据的验收服务器（图片提供方固定为 **mock fixture**）：

```bash
node scripts/document-extraction-acceptance-server.mjs
# 使用上一步打印的 URL：
playwright-cli -s=agentbl-wp22 open <URL> --browser=msedge
playwright-cli -s=agentbl-wp22 --raw run-code --filename=scripts/document-extraction-acceptance.playwright.js
playwright-cli -s=agentbl-wp22 close
# 在服务器终端 Ctrl+C，停止自己启动的服务器并清理临时运行时目录。
```

脚本生成确定性的实际 PDF 文件，通过真实文件输入上传，验证 PDF 数值/页码、扫描挂起、模拟视觉 75% 上限、中英切换、1440/390px、重复上传、修正补件重跑、缺字段提示及历史 HOLD 保留。CLI 文件选择器的模态状态会滞留，所以脚本只抑制原生选择器，仍点击真实复核按钮并通过真实 input 的 change 事件提交；它不证明原生文件选择器的人工操作。内置浏览器面板返回 queued，自动化交互在本机 Edge 完成。Windows curl 另外核对 WSL 服务器入口。

验收结果见 [本地记录](evidence/document-extraction-local.json) 和 [浏览器记录](evidence/document-extraction-browser.json)。真实视觉/文本提供方、真实扫描 OCR、用户人工试用、远端 CI、提交、推送与部署均不能从这些本地检查推断。

下一工作包为 **WP2.3 合规 v2**。本阶段建议单独提交 `feat(agent): extract PDF text and review model document fields`；未经用户要求不提交、不推送。
