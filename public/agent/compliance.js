import { el } from '../dom.js';
import { t } from '../i18n.js';

/** Localized, text-only screening evidence. A demo CLEAR is never called legal clearance. */
export function renderCompliance(report) {
  const section = el('details', { class: 'ebl-compliance' }, el('summary', {}, `${t('comp_title')} · ${t(`comp_status_${report.status}`)}`));
  section.append(el('p', { class: 'muted' }, `${t('comp_list')}: ${report.list_version} · ${t('comp_as_of')}: ${report.as_of}`),
    el('p', { class: 'cp-warning' }, t('comp_disclaimer')));
  for (const check of report.checks ?? []) {
    const code = `comp_code_${check.code}`, translated = t(code);
    const row = el('div', { class: 'ebl-compliance-check' }, el('strong', {}, `${t(`comp_category_${check.category}`)} · ${t(`comp_status_${check.status}`)}`),
      el('p', {}, translated === code ? t('comp_code_INPUT_REVIEW') : translated));
    const facts = el('dl', { class: 'ebl-fields' });
    const evidence = check.evidence ?? {};
    if (evidence.document_name) facts.append(el('dt', {}, t('comp_document')), el('dd', {}, evidence.document_name));
    if (evidence.value) facts.append(el('dt', {}, t('comp_value')), el('dd', {}, evidence.value));
    if (evidence.matched_name) facts.append(el('dt', {}, t('comp_match')), el('dd', {}, evidence.matched_name));
    if (evidence.entry_id && typeof evidence.score === 'number') facts.append(el('dt', {}, t('comp_score')), el('dd', {}, `${(evidence.score * 100).toFixed(1)}%`));
    if (evidence.country) facts.append(el('dt', {}, t('comp_country')), el('dd', {}, evidence.country));
    if (evidence.hs_prefix) facts.append(el('dt', {}, t('comp_hs_prefix')), el('dd', {}, evidence.hs_prefix));
    if (evidence.declared_standards?.length) facts.append(el('dt', {}, t('comp_standards')), el('dd', {}, evidence.declared_standards.join(', ')));
    row.append(facts); section.append(row);
  }
  return section;
}
