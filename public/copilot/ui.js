import { el, clear } from '../dom.js';
import { t, tData } from '../i18n.js';
import { riskLabel } from '../format.js';

export function poolStateLabel(status) {
  const key = `cp_state_${status}`;
  return t(key) === key ? status : t(key);
}

export function renderConstraints(context) {
  const wrap = el('div', { class: 'cp-constraints', 'aria-label': t('cp_filters') });
  for (const [key, value] of Object.entries(context?.constraints ?? {})) {
    if (Array.isArray(value) && !value.length) continue;
    const label = t(`cp_filter_${key}`);
    const formatted = key === 'yield_min_bps' ? `${value / 100}%` : key === 'risk_max' ? riskLabel(value)
      : Array.isArray(value) ? value.map((item) => key.startsWith('commodities_') ? t(`cp_commodity_${item}`) : item).join(', ') : String(value);
    wrap.append(el('span', { class: 'cp-chip' }, `${label}: ${formatted}`));
  }
  if (!wrap.childNodes.length) wrap.append(el('span', { class: 'muted' }, t('cp_no_filters')));
  return wrap;
}

export function decisionButton(id) {
  return el('button', { class: 'ghost cp-link', type: 'button', onclick: () =>
    window.dispatchEvent(new CustomEvent('agentbl:decisionopen', { detail: { decision_id: id } })) }, t('cp_decision'));
}

export function renderRecommendations(container, result, { onSelect = () => {} } = {}) {
  clear(container);
  container.append(renderConstraints(result.context));
  if (result.clarifying_question) container.append(el('p', { class: 'cp-question', role: 'status' }, result.clarifying_question));
  for (const item of result.recommendations ?? []) {
    const card = el('article', { class: 'cp-card' },
      el('strong', {}, `${item.rank}. ${tData(item.label)}`), el('p', {}, tData(item.route)),
      el('p', {}, t('cp_metrics', { price: item.price_usd.toFixed(4), yield: (item.yield_bps / 100).toFixed(2), risk: riskLabel(item.risk_level) })),
      el('p', { class: 'muted' }, t('cp_mirror_note')),
      el('button', { type: 'button', class: 'ghost', onclick: () => onSelect(item.case_id) }, t('cp_open_asset')));
    for (const warning of item.warnings ?? []) card.append(el('p', { class: 'cp-warning' }, t(`cp_warning_${warning}`)));
    const explanation = el('details', {}, el('summary', {}, t('cp_explanation')));
    for (const [key, score] of Object.entries(item.breakdown)) explanation.append(el('p', {}, `${t(`cp_score_${key}`)}: ${score.toFixed(4)}`));
    explanation.append(el('p', {}, t('cp_gross_note')));
    for (const evidence of item.evidence ?? []) {
      if (evidence.kind === 'risk_intel') explanation.append(el('p', { class: 'muted' }, `${t('cp_fixture_intel')}: ${evidence.text}`));
    }
    if (item.quote_hash) explanation.append(el('code', { class: 'cp-hash', title: item.quote_hash }, item.quote_hash));
    if (item.decision_id) explanation.append(decisionButton(item.decision_id));
    card.append(explanation); container.append(card);
  }
  if (result.excluded_notable?.length) {
    const details = el('details', {}, el('summary', {}, t('cp_excluded')));
    for (const item of result.excluded_notable) details.append(el('p', {}, `${tData(item.label)}: ${item.reasons.map((reason) => t(`cp_exclude_${reason}`)).join(' · ')}`));
    container.append(details);
  }
  if (result.action_required) container.append(el('p', { class: 'cp-warning' }, t('cp_manual_action')));
}
