# 研究数据与可选模型

## 数据用途

| 位置 | 用途 |
| --- | --- |
| `data/cases/`、`data/demo-case.json` | 虚构贸易案例、定价与页面演示 |
| `data/uploads/` | 单证解析与审单样本，见目录内 README |
| `data/desensitizationData/` | 应用正在加载的仓储、运输和购销材料 |
| `data/scenarios/`、`data/pricing-scenarios/`、`data/agent-scenarios/` | 风险、定价和 Agent 回归 |
| `data/real-data/`、`data/world-intel/`、`data/risk-intel/` | 带时间及来源的观测或研究快照 |
| `data/evaluation/w4/` | 现有来源评估语料、公开样本与许可 |

这些文件仍被应用或回归使用。虚构案例不证明真实成交，日期平移不使旧行情成为新观测。来源状态以 live / stale / fixture / unavailable 区分；缺失、过期、回退和失败须可见。

风险 bps 是研究策略分，不是校准过的违约概率。当前确定性定价约束资方研究下限、借款人成本、担保与期限；无共同可行区间则拒绝或降额。目标兑付不是收益预测，FAST / BALANCED / LOW_COST 不保证撮合速度。

## 可选模型

接入使用 `.env.example` 的实际变量，配置 provider、model、端点、输出 token 上限及可选 reasoning effort。连通性不代表模型身份、质量或业务适用性已经通过。

材料视为不可信输入，抽取保留来源和不确定性；模型超时或无效输出进入可见回退。LLM 可以解释确定性结果，不能绕过资格、签名或修改已签条款。

```sh
npm run eval:agent -- --check
npm run eval:providers
npm run eval:market
```

以上默认离线验证。`npm run eval:screening` 访问外部来源；`npm run eval:providers -- --live` 和 `npm run eval:agent -- --live-llm` 使用已配置服务，可能产生调用费用。它们保留为可选工具，不再作为新增交付任务。

`npm run evidence:verify -- <证据包>` 可独立复算承诺。承诺一致证明内容未变，不能证明单证或货物真实。评估产物写入忽略的执行目录；纳入正式样本的数据须带来源、许可和摘要。
