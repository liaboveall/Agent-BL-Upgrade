# AgentBL Agent 评测报告

生成时间：2026-10-15T02:56:00.545Z（UTC）。模式：deterministic。
代码基线：9cefb50519aefdd2b1774036fd048cbfb27859ad；工作区有改动：true。
代码摘要：9de9dc570529d9627c2b8e1966664920157585596a18578b5c50a6014ba1fb66。
金标版本：agent-gold-v3-generated-redteam；金标与输入摘要：0x74b0e573ed46794f571c9d69614dc5ed97d52cd7e04989ed035ec613b5d1ee80。

这是对真实本地组件的测量。确定性闸门：**PASS**。
闸门通过与逐样例全对是两种结果；失败样例照实列出。金标不传入被测组件。

## 指标与冻结阈值

| 指标 | 实测 | 阈值 | 状态 |
|---|---:|---:|---|
| extraction_precision | 1 | >= 0.9500 | PASS |
| extraction_recall | 1 | >= 0.9000 | PASS |
| extraction_exact_match | 1 | >= 0.8500 | PASS |
| consistency_precision | 1 | >= 0.9000 | PASS |
| consistency_recall | 1 | >= 0.9000 | PASS |
| compliance_accuracy | 1 | >= 0.9000 | PASS |
| compliance_false_block_rate | 0 | <= 0.2000 | PASS |
| pricing_violations | 0 | <= 0 | PASS |
| loop_exact_match | 1 | >= 1 | PASS |
| duplicate_executions | 0 | <= 0 | PASS |
| policy_violations | 0 | <= 0 | PASS |
| intent_accuracy | 1 | >= 0.9500 | PASS |
| constraint_f1 | 1 | >= 0.9500 | PASS |
| recommendation_constraint_rate | 1 | >= 1 | PASS |
| ndcg_at_3 | 1 | >= 0.8000 | PASS |
| override_accuracy | 1 | >= 1 | PASS |
| clarification_accuracy | 1 | >= 1 | PASS |
| attack_success_rate | 0 | <= 0 | PASS |
| benign_hold_rate | 0 | <= 0 | PASS |
| redteam_detection_rate | 1 | >= 1 | PASS |

## 样本与配置

```json
{
  "counts": {
    "extraction": {
      "documents": 19,
      "annotated_fields": 82,
      "tp": 82,
      "fp": 0,
      "fn": 0
    },
    "consistency": {
      "cases": 10,
      "tp": 12,
      "fp": 0,
      "fn": 0
    },
    "compliance": {
      "cases": 20,
      "false_blocks": 0,
      "allowed": 13
    },
    "pricing": {
      "seed": 5322,
      "generated_cases": 150,
      "quotes": 1350
    },
    "loop": {
      "scenarios": 3
    },
    "copilot": {
      "dialogues": 44,
      "turns": 100,
      "recommendations": 206,
      "overrides": 16,
      "clarification_checks": 84,
      "ranking_queries": 6,
      "tp": 122,
      "fp": 0,
      "fn": 0,
      "llm_intent_turns": 0,
      "deterministic_intent_turns": 100,
      "llm_narrative_turns": 0,
      "template_narrative_turns": 100
    },
    "injection": {
      "attacks": 26,
      "successful_attacks": 0,
      "benign_controls": 1
    },
    "redteam": {
      "cases": 17,
      "detected": 17,
      "seed": 5322
    }
  },
  "config": {
    "network_access": false,
    "seed": 5322,
    "model_evaluation": "disabled",
    "extraction_scope": "precision/recall over annotated fields; unannotated fields are not scored",
    "ranking_catalogue": "eight hypothetical pool snapshots"
  }
}
```

抽取 P/R 只覆盖人工标注字段；错值同时计 FP 和 FN，缺失值计 FN。整体精确匹配要求该样例所有标注字段和单证类型一致。
一致性 P/R 以问题 ID 为单位。约束 F1 按键值与集合元素做微平均；推荐约束检查使用独立判定器。NDCG@3 使用人工给出的相关度，重复候选不能重复得分。
定价使用固定种子，分别检查三档速度和递增风险严重度；自主循环跑真实场景播放器、策略和 Demo 执行器，再次播放检查去重。
注入样本进入真实九步接入流水线，要求 HOLD 和注入发现同时成立，并有干净单证对照。

## 失败样例（0）

本次有限样本没有失败。

## 局限

- Fictional local fixtures and perturbations; paired translations are 44 dialogues but only 22 distinct scenarios, not a held-out benchmark.
- Extraction scores cover annotated text fields, not OCR/PDF/vision or all emitted fields. Whitespace variants are correlated examples.
- Compliance measures versioned demo rules and CLEAR/REVIEW/BLOCK labels, not official sanctions screening. Historical v1 keyword gold is retained separately; Miranda and country words are negative regressions.
- NDCG uses six manually graded queries on eight hypothetical pools; it is not an Amazon benchmark or real investor validation.
- Autonomous loops use the actual Demo executor and explicit simulated operator approvals; no real chain transaction is measured.
- Injection ASR is measured on this finite pattern suite, not a general resistance claim.
- No real LLM/provider evidence exists unless the separate live-llm run was explicitly invoked.

## 可选 LLM 对比

SKIP：未执行真实提供方评测。仅人工运行 `npm run eval:agent -- --live-llm` 时尝试真实 LLM 路径；其指标不阻断 CI。

完整逐样例结果与代码文件摘要保存在 [evidence/agent-eval.json](evidence/agent-eval.json)。
