# PRD Agent API（WP2.9）

2026-10-15：PRD §9.2 的五个接口已接入真实组件。它们是独立计算接口：不创建上传作业、决策、审批、发行池或交易，不读取调用方指定的本地路径。持久上传及复核仍使用 `/api/agent/ingest`。

所有接口只接受 `POST` 和 `Content-Type: application/json`，响应均含 `ok`、`stateless: true`、`chain_action_executed: false` 和 `assessment`。Demo 和 Live 使用同一套计算；这些纯计算不需要 owner 或管理员密钥。

| 路径（前缀 `/api/agent/`） | 请求 | 结果 |
|---|---|---|
| `extract-documents` | `{documents, case_id?}` | `extraction`：单证类型、字段、来源行/页码、置信度、原始字节 SHA-256、合并的 `case_data` 和复核发现 |
| `verify-documents` | `{case_data?, documents?}`，至少一项 | `assessment.verification` 一致性检查与风险惩罚；逐份单证的版本化演示合规 |
| `price-rwa` | `{case_data, documents?, payout_speed?, min_acceptable_issue_price?}` | `quote`：与 `quoteFromCase` 同源的确定性报价、风险、证据图与哈希，`indicative_only: true` |
| `generate-investor-brief` | 同报价，另可带 `use_llm: true` | `brief`：基于 `pricingNarrator` 的原始事实、正文、来源、风险和限制说明；报价独立返回 |
| `generate-evidence-graph` | 同报价 | `evidence_graph`、`graph_hash`、`quote_evidence_hash`；明确 `anchoring: offchain-only` |

`documents` 为 1–12 项数组，每项是 `{name, mime_type, text}` 或 `{name, mime_type, content_base64}`，可另带 `declared_type`（`EBL` / `COMMERCIAL_INVOICE` / `INSURANCE_POLICY` / `WAREHOUSE_RECEIPT`）。字节、文件魔数、UTF-8、类型与大小使用持久上传的同一校验器；不支持 `path`、客户端 `buffer`、工具或提示词参数。

```json
{
  "documents": [{
    "name": "invoice.txt",
    "mime_type": "text/plain",
    "declared_type": "COMMERCIAL_INVOICE",
    "text": "Commercial Invoice\nInvoice No: INV-001\nCurrency: USD\nQuantity: 500 MT\nTotal Amount: USD 6,875,000"
  }]
}
```

报价请求中的 `case_data` 是完整的结构化案例，可以直接使用 `data/cases/copper-sg-shanghai.case.json` 的内容（将文件解析为 JSON 对象）。不传 `payout_speed` 时沿用案例偏好；可显式选择 `FAST`、`BALANCED`、`LOW_COST`。案例必须包含身份、正数量、美元货值、保险金额和融资金额；不完整或仅 CNY 的案例返回 `422 pricing_inputs_required`，不会虚构货值或汇率。

## 证据与复核

- `assessment.status` 为 `READY_FOR_PRICING` / `HOLD_FOR_REVIEW` / `REJECT`。所有输入均标为 `caller-supplied`、`registry_verified: false`，计算通过不等于登记验真或允许交易。
- 空案例、缺少交叉核验字段、未知/不可读/扫描单证、低置信度、提示注入、一致性冲突、单证覆盖前后字段冲突、合规 REVIEW 均保留复核状态；合规 BLOCK 返回 REJECT。冲突单证中的实体仍逐份筛查，不能由后来的清白摘要覆盖。
- 报价仍可作为阻断/复核案例的参考计算；`assessment` 和 `indicative_only` 明确其边界。价格本身不会发起 OPEN。
- PDF 文本提取使用现有有界 worker；图片视觉和缺字段补全遵守 `AGENT_VISION_ENABLED` / `AGENT_DOCUMENT_LLM`，默认关闭。模型失败保留复核发现，原始文档内容不写入运行时。
- 图前四个定价节点直接来自定价引擎的 `buildEvidenceGraph`。另有原始输入案例与合并案例承诺、每份单证的字节/字段承诺、一致性和版本化合规节点。`graph_hash` 是整个图的规范 JSON SHA-256，与原有报价 `evidence_hash` 分开命名，未声称上链锚定。对象键重排不改变哈希；原始案例、单证字节或判断变化会改变哈希。
- 合规数据是虚构演示名单，响应保留版本、日期、数据哈希及免责声明，不构成正式名单筛查或法律结论。

## 全项目模型配置

API 模型默认统一为 **`x-test-2`**。Agent、文档视觉/补全、Copilot、浏览器中继、共识调用、CLI 和评测共享 `resolveProvider()`；腾讯旧锁定已移除。`.env.example` 中设置 `LLM_MODEL=x-test-2`。已有本地 `.env` 也仅定点更新了该字段，其余配置保留，没有显示密钥。

`LLM_MODEL` 仍是运维显式覆盖入口，空白值回退 `x-test-2`。Azure 的请求体也使用该模型名，`AZURE_OPENAI_DEPLOYMENT` 仍是实际资源的路由标识，部署时应确认该路由确实提供目标模型。内置厂商端点只是兼容配置；本地桩测试不证明真实端点支持 `x-test-2`。

简报默认完全确定性。只有显式 `use_llm: true` 且 `LLM_PROXY_ENABLED` 未关闭、没有复核/阻断时才尝试润色；它不能修改返回的报价，正文经过价格/风险/动作、数字白名单、事实词汇及非保证性声明检查，空输出、超时或未通过检查均返回原始事实正文。不将异常中的上游详情写回响应。

## 资源限制和错误

| 配置 | 默认 | 作用 |
|---|---|---|
| `AGENT_API_RATE_LIMIT_PER_MIN` | 30 | 五个接口共用每客户端一分钟预算；无效的 POST 负载也计数；0 关闭此预算 |
| `AGENT_API_MAX_CONCURRENCY` | 4 | 五个接口共用并发上限，限定 1–64；错误或断连后完成的计算释放槽位 |
| `AGENTBL_MAX_BODY_BYTES` | 1 MiB | JSON 请求体字节上限 |
| `AGENT_UPLOAD_MAX_BYTES` | 8 MiB | 单份解码后文档上限，仍受总请求体上限约束 |

未知/伪造顶层字段、非数值金额、异常日期或过深结构返回 400；错误方法 405；非 JSON 或字节/声明类型不符 415；体积超限 413；缺少可定价输入 422；限流/并发返回 429 并附 `Retry-After`。同时保留服务器通用读写限流、代理来源规则和 `Cache-Control: no-store`。

## 测试

```text
node --test tests/agentStatelessApi.test.js tests/llmProjectModel.test.js
```
