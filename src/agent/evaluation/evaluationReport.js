import { runEvaluation } from './runner.js';

export const runComprehensiveEvaluation = runEvaluation;
const show = (value) => Number.isInteger(value) ? String(value) : value.toFixed(4);

export function renderEvaluationReport(evaluation) {
  const source = evaluation.source ?? {};
  return `# AgentBL Agent 评测报告

生成时间：${evaluation.generated_at}（UTC）。模式：${evaluation.mode}。
代码基线：${source.commit ?? 'unrecorded'}；工作区有改动：${source.dirty ?? 'unrecorded'}。
代码摘要：${source.sha256 ?? 'unrecorded'}。
金标版本：${evaluation.dataset_version}；金标与输入摘要：${evaluation.dataset_hash}。

这是对真实本地组件的测量。确定性闸门：**${evaluation.passed ? 'PASS' : 'FAIL'}**。
闸门通过与逐样例全对是两种结果；失败样例照实列出。金标不传入被测组件。

## 指标与冻结阈值

| 指标 | 实测 | 阈值 | 状态 |
|---|---:|---:|---|
${evaluation.gates.map((gate) => `| ${gate.metric} | ${show(gate.actual)} | ${gate.direction} ${show(gate.threshold)} | ${gate.passed ? 'PASS' : 'FAIL'} |`).join('\n')}

## 样本与配置

\`\`\`json
${JSON.stringify({ counts: evaluation.counts, config: evaluation.config }, null, 2)}
\`\`\`

抽取 P/R 只覆盖人工标注字段；错值同时计 FP 和 FN，缺失值计 FN。整体精确匹配要求该样例所有标注字段和单证类型一致。
一致性 P/R 以问题 ID 为单位。约束 F1 按键值与集合元素做微平均；推荐约束检查使用独立判定器。NDCG@3 使用人工给出的相关度，重复候选不能重复得分。
定价使用固定种子，分别检查三档速度和递增风险严重度；自主循环跑真实场景播放器、策略和 Demo 执行器，再次播放检查去重。
注入样本进入真实九步接入流水线，要求 HOLD 和注入发现同时成立，并有干净单证对照。

## 失败样例（${evaluation.failed_cases.length}）

${evaluation.failed_cases.length ? evaluation.failed_cases.map((entry) => `- **${entry.suite}/${entry.id}**：${JSON.stringify({ actual: entry.actual ?? entry.issues ?? entry.pool_ids, gold: entry.gold })}`).join('\n') : '本次有限样本没有失败。'}

## 局限

${evaluation.limitations.map((limitation) => `- ${limitation}`).join('\n')}

## 可选 LLM 对比

${evaluation.live_llm ? `状态：${evaluation.live_llm.status}。${evaluation.live_llm.notice}\n\n${evaluation.live_llm.metrics ? `\`\`\`json\n${JSON.stringify({ metrics: evaluation.live_llm.metrics, counts: evaluation.live_llm.counts }, null, 2)}\n\`\`\`` : ''}` : 'SKIP：未执行真实提供方评测。仅人工运行 `npm run eval:agent -- --live-llm` 时尝试真实 LLM 路径；其指标不阻断 CI。'}

完整逐样例结果与代码文件摘要保存在 [evidence/agent-eval.json](evidence/agent-eval.json)。
`;
}

export async function generateEvaluationReport(options) {
  return renderEvaluationReport(await runEvaluation(options));
}
