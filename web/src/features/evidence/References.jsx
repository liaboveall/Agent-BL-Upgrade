// The saved references of an agent decision (decision id, quote hash, report ids, transactions),
// shown the same way on the market card panel, the pricing view, the report view, the portfolio and
// the decision drawer.
import { t } from '../../lib/i18n.js';
import { CopyButton, Disclosure } from '../../components/ui.jsx';

export function References({ references, open = false }) {
  const rows = [];
  if (references) {
    const add = (kind, label, value) => { if (value) rows.push({ kind, label, value }); };
    add('decision', t('ac_decision_id'), references.decision_id);
    add('quote', t('ac_quote_hash'), references.quote_hash);
    for (const id of references.report_ids ?? []) add('report', t('ac_report_id'), id);
    for (const id of references.tx_hashes ?? []) add('transaction', t('ac_exec_tx'), id);
    for (const payment of references.report_payment_txs ?? []) add('report-payment', t('ac_report_payment'), payment.tx_hash);
  }
  return (
    <Disclosure className="evidence-references" summary={t('ac_linked_evidence')} defaultOpen={open} data-decision-id={references?.decision_id ?? ''}>
      {!references ? <p className="muted">{t('ac_no_linked_decision')}</p> : (
        <>
          <dl className="ref-list">
            {rows.map((row) => (
              <div key={`${row.kind}:${row.value}`} className="ref-row">
                <dt>{row.label}</dt>
                <dd><code data-reference-kind={row.kind} data-reference-value={row.value}>{row.value}</code><CopyButton value={row.value} /></dd>
              </div>
            ))}
          </dl>
          {!references.report_ids?.length ? <p className="muted small">{t('ac_no_report')}</p> : null}
          {!references.tx_hash ? <p className="muted small">{t('ac_no_chain_tx')}</p> : null}
        </>
      )}
    </Disclosure>
  );
}

export function openDecision(decisionId) {
  window.dispatchEvent(new CustomEvent('agentbl:decisionopen', { detail: { decision_id: decisionId } }));
}

export function DecisionButton({ id, label }) {
  return (
    <button type="button" className="link-btn" onClick={() => openDecision(id)}>
      {label ?? t('cp_decision')}
    </button>
  );
}
