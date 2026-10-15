// Project saved evidence across views without borrowing IDs from a newer decision or report.
const TX = /^0x[0-9a-fA-F]{64}$/u;
const REPORT = /^rpt_[0-9a-f]{64}$/u;

export function decisionQuote(decision) {
  return decision?.quote_snapshot ?? decision?.proposal?.params?.quote ?? null;
}

export function decisionReferences(decision) {
  const quote = decisionQuote(decision);
  const reports = (quote?.paid_report_evidence ?? []).filter((report) => REPORT.test(report.report_id));
  const execution = decision?.execution;
  const transactions = execution?.mode === 'chain'
    ? [...new Set([execution.tx_hash, ...(execution.tx_hashes ?? []), ...(execution.transactions ?? []).map((tx) => tx.tx_hash)].filter((tx) => TX.test(tx ?? '')))] : [];
  return {
    decision_id: decision?.decision_id ?? null,
    case_id: decision?.case_id ?? null,
    quote_hash: quote?.quote_hash ?? decision?.quote_hash ?? null,
    report_ids: [...new Set(reports.map((report) => report.report_id))],
    tx_hash: transactions[0] ?? null,
    tx_hashes: transactions,
    report_payment_txs: reports.filter((report) => TX.test(report.payment_tx ?? '')).map((report) => ({ report_id: report.report_id, tx_hash: report.payment_tx }))
  };
}

export function withReferences(decision) {
  return decision ? { ...decision, references: decisionReferences(decision) } : null;
}
