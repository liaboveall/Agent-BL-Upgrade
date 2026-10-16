# 合规 v2：演示名单与单证筛查

WP2.3 使用带版本的内置演示名单替换了名字关键词规则。CLEAR 表示未命中本次演示规则，REVIEW 转人工复核，BLOCK 拒绝接入。它没有查询官方制裁名单，也不作法律、许可、ECCN 或 EAR99 判定。

## 数据与来源

`data/compliance/screening-list.json` 为 `demo-screening-v2.0`，资料日期 2026-10-14。实体、别名和船名均为虚构，IMO 为合成测试值，不表示任何真实船舶被制裁；地区和军品/两用物项 HS 前缀都是演示规则。`data/compliance/ports.json` 为 `demo-ports-v1.1`（2026-10-16 补充了 Fujairah、Santos、Dalian、Laem Chabang、Hamburg），覆盖全部现有案例的海港和佛山仓库地点。仓库别名只用于判断国家，不把仓库当海港。

加载时校验演示标记、字段、重复 ID、国家代码与 IMO 校验位。报告保存名单版本、地点版本、资料日期和数据 SHA256；无效数据会使加载失败，不回退到全通过。

来源只提供背景，没有导入真实实体名单：[OFAC 项目目录](https://ofac.treasury.gov/sanctions-programs-and-country-information)、[UNECE 地点代码目录](https://unece.org/trade/cefact/unlocode-code-list-country-and-territory)、[美国国际贸易管理局的出口分类说明](https://www.trade.gov/how-do-i-determine-my-export-control-classification-number-eccn)。原规划中的 SY 示例未加入阻断表：[OFAC 说明](https://ofac.treasury.gov/faqs/topic/1571/print)确认其一般叙利亚制裁计划已于 2025-07-01 终止。IR/KP/CU 在这里是演示流程规则，不是对具体交易适用法律的判断。

## 判断规则与证据

实体先统一大小写与字符形式、去标点和公司后缀；逗号或分号后的地址不会掩盖前面的名称。分数为 `0.3 × token Jaccard + 0.7 × Jaro-Winkler`，按未舍入值判断：`≥ 0.92` 为 BLOCK，`0.85 ≤ score < 0.92` 为 REVIEW。名字里的国家词不会直接变成命中，`Miranda Trading`、`Iran Trading` 等有负向回归。

交易方、承运人、通知方、发票/仓单交易方与保险提供方都参与筛查。船名使用同一匹配器，船舶 IMO 单独检查格式、校验位和精确命中。解析器支持 Vessel IMO / IMO Number 及来源行号，不把样例里的 Carrier IMO: 9## (demo) 推测为船舶 IMO。

**每份已解析单证分别筛查，最终合并案例也参加筛查。** 后面的同类型文件不能覆盖前面的阻断交易方或 HS；证据包含字段路径与原文文件名。提单和发票的 HS、运输地点与 IMO 分别保留。

运输地点通过有边界的别名或明确代码推导国家。未知、缺失、格式错误或多国家歧义需要复核；混入已知演示受限地点时保留 BLOCK。HS 只匹配内置示例前缀，缺失或无效编码需要复核；军用或两用货物声明也会触发演示规则，不被普通 HS 编码放行。

从 ebl_platform 和兼容 metadata 识别声明的 DCSA、eUCP、MLETR、ICC DSI 名称。报告只说已声明，不声称验证平台符合性或法律效力；未识别声明时复核，仓单不推测海运提单标准。企业规模不是拒绝服务的条件。

每项证据包含 list_version、field、entry_id、score，以及命中名称、地区、HS 前缀或原文文件名。空值、超长值、隐藏字符、注入指令或异常字段转人工复核，字段内容始终作为数据。

## 流水线与界面

编排器等待筛查完成，任何 REVIEW 变成 COMPLIANCE_REVIEW，任何 BLOCK 变成 COMPLIANCE_BLOCK。CNY 仓单和无法报价的已解析单证也先筛查。完整报告随作业和决策落盘，决策输入摘要保存报告哈希；正常报价路径另含名单版本。

修正单证建立新作业、重跑筛查并保留旧报告；重复上传保持幂等，人工备注不能直接取消筛查。中英文界面提供可折叠证据、资料日期、字段原值、虚构匹配项、分数、原文文件和复核提示。证据用文本节点渲染，内部名单 ID 留在 API 审计记录中。

## 可选外部接口

默认完全使用内置名单。COMPLIANCE_SCREENING_URL 和 COMPLIANCE_SCREENING_TIMEOUT_MS 为显式集成保留，设置 URL 本身不会发请求。运维代码必须给 createExternalComplianceChecker 注入 transport，再把函数交给编排器。本阶段只用 mock 验证它。

请求为 `{schema_version: "agentbl-screening-v1", demo_list_version, facts}`，只发送类别、字段和事实，不发送文件原文、密钥、价格或提示词。响应为 `{status, list_version, checks}`，每项检查为 `{id, status, detail, field, entry_id, score}`。总状态必须与 CLEAR/REVIEW/BLOCK 检查一致；无效字段、分数、矛盾结果或超量输出均拒绝。

默认超时 1500ms，允许 1–30000ms；禁止重定向、带凭据或 fragment 的 URL。超时中止请求，即使 transport 不响应 AbortSignal 也结束等待。失败或无效结果保留内置证据并转 REVIEW，外部 CLEAR 不能覆盖本地 BLOCK/REVIEW。没有连接真实筛查服务。

## 测试

```text
node --test tests/complianceChecker.test.js tests/agentIngestPipeline.test.js
```

自动化不代表官方筛查、真实提供方准确率、人工试用、实体设备、真实链上写入、远端 CI 或部署验收。
