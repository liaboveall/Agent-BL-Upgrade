import { el } from '../dom.js';
import { t } from '../i18n.js';
import { copyButton } from './ui.js';

/** Five surfaces render the same saved references inside an evidence disclosure. */
export function renderReferences(references, { open = false } = {}) {
  const root = el('details', { class: 'evidence-references', open,
    'data-decision-id': references?.decision_id ?? '' }, el('summary', {}, t('ac_linked_evidence')));
  if (!references) { root.append(el('p', { class: 'muted' }, t('ac_no_linked_decision'))); return root; }
  const rows = el('dl', { class: 'ac-kvlist' });
  const add = (kind, label, value) => {
    if (!value) return;
    rows.append(el('dt', {}, label), el('dd', {}, el('code', { 'data-reference-kind': kind, 'data-reference-value': value }, value), ' ', copyButton(value)));
  };
  add('decision', t('ac_decision_id'), references.decision_id);
  add('quote', t('ac_quote_hash'), references.quote_hash);
  for (const id of references.report_ids ?? []) add('report', t('ac_report_id'), id);
  for (const id of references.tx_hashes ?? []) add('transaction', t('ac_exec_tx'), id);
  for (const payment of references.report_payment_txs ?? []) add('report-payment', t('ac_report_payment'), payment.tx_hash);
  root.append(rows);
  if (!references.report_ids?.length) root.append(el('p', { class: 'muted ac-small' }, t('ac_no_report')));
  if (!references.tx_hash) root.append(el('p', { class: 'muted ac-small' }, t('ac_no_chain_tx')));
  return root;
}
