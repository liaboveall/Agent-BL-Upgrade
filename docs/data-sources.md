# 数据、研究参数与外部服务

## 当前数据的用途

| 位置 | 用途与边界 |
|---|---|
| `data/cases/`、`data/demo-case.json` | 虚构贸易案例、确定性定价和 UI 演示，不证明现实成交或企业关系 |
| `data/uploads/` | 解析、审单和上传示例；当前单据均为研究样本，见目录内 README |
| `data/desensitizationData/` | 应用仍在加载的仓储/运输/购销研究材料，并非废弃脚手架 |
| `data/scenarios/`、`data/pricing-scenarios/`、`data/agent-scenarios/` | 风险、定价与 Agent 回归样本 |
| `data/real-data/`、`data/world-intel/`、`data/risk-intel/` | 观测或研究快照，具体来源、时间、适用范围以内容为准 |
| `data/evaluation/w4/` | 当前来源和模型验证使用的语料、公开样本及许可；W4 是既有目录名 |

Demo 可按 `src/core/caseDates.js` 平移研究日期；这种变换不能让旧行情或真实来源变成最新观测。来源应有观测时间、有效期和 live/stale/fixture/unavailable 状态；缺失和失效要显式展示。

风险 bps 是未校准策略压力分，不能当违约概率。确定性研究定价主要约束借款人成本和担保覆盖，尚未证明资方补偿足够。发行价、到期应付、目标兑付、预期收益和可交易市值是不同概念。FAST/BALANCED/LOW_COST 不保证撮合速度或到账时间。

补齐资方下限、借款人上限、可回收担保和期限共同可行区间的工作在 N2.2；无可行区间应拒绝或降额，不能由模型补出有利数字。

## 模型与接入

密钥与端点使用 `.env.example` 的实际变量；真实值不进入文档、公开配置、截图或日志。OpenAI-compatible 接入的 provider/model、代理开关、输出 token 上限和可选 `LLM_REASONING_EFFORT` 见示例文件及 `src/agent/llm/openaiCompatClient.js`。连通性不等于模型身份、输出质量或业务适用性通过。

文档内容视为不可信输入，字段抽取带来源和不确定性。超时、无效输出和回退应可见，并进入人工接管。LLM 可以解释确定性结果，不得绕过资格、签名或改变已签条款。

```powershell
npm run eval:agent -- --check
npm run eval:w4
npm run eval:w4:market
```

这些默认入口用于离线研究验证。market 入口评估价格基准误差，不是货物净回收估值。`npm run eval:w4:screening` 访问外部公开来源；`eval:w4 -- --live` 和 `eval:agent -- --live-llm` 使用已配置服务，可能产生外部调用与费用，按实际使用范围运行。

`npm run agent:value` 是研究估值示例，外部模式需单独核验材料、工具调用和适用性。`npm run evidence:verify` 可独立复算下载包；承诺匹配证明内容一致，不能证明陈述真实。

## 执行产物

Agent/provider/market/screening 的新评估写入 `artifacts/` 的带时间目录，失败也保留。正式纳入回归的数据须带来源、许可、版本和摘要进入 `data/`，不能只复制某次成功输出作为正确答案。

原始评估中的 provider 超时及无效输出保存在历史快照，未因整理而消失。任务和业务门槛见 [规划](development-plan.md)，旧材料见 [历史说明](history.md)。
