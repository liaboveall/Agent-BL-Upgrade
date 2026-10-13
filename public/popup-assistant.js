// Investor Copilot: the server owns context, retrieval, ranking and explanations.
// The browser renders results and opens asset panels; messages never execute a transaction.
import { el, clear } from './dom.js';
import { state } from './store.js';
import { t, onLangChange } from './i18n.js';
import { copilotQuery, resetCopilotSession } from './copilot/api.js';
import { renderRecommendations, poolStateLabel } from './copilot/ui.js';

async function serverJson(path) {
  const response = await fetch(path);
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

// Compatibility for integrations that used the read-only assistant tools.
export const toolExecutors = {
  async getAgentActivity({ limit = 10 } = {}) {
    const result = await serverJson(`/api/agent/activity?limit=${Math.min(50, Math.max(1, Number(limit) || 10))}`);
    if (!result.activities.length) return '暂无决策记录。';
    return result.activities.map((item) => `${item.action}${item.tx_hash ? ` · ${item.tx_hash}` : ''}`).join('\n');
  },
  async getPortfolio() {
    const result = await serverJson(`/api/investors/portfolio?wallet_address=${encodeURIComponent(state.wallet?.address || '0xDemoWallet')}`);
    return result.investments.map((item) => `${item.label} · Demo 模拟 · ${item.riskLevel === 'WARNING' ? '🟠' : ''}${item.riskLevel} · ${item.reference}`).join('\n') || t('portfolio_empty');
  },
  async recommendEBL({ preference }) { return (await copilotQuery(preference)).narrative; },
  async compareEBLs({ case_ids = [] }) { return (await copilotQuery('compare', { pool_ids: case_ids })).narrative; }
};

let initialized = false;
export function initPopupAssistant() {
  if (initialized) return;
  initialized = true;
  const launcher = el('button', { type: 'button', class: 'cp-launcher', 'aria-controls': 'copilot-dialog', 'aria-expanded': 'false' });
  const transcript = el('div', { class: 'cp-transcript' });
  const title = el('strong', { id: 'copilot-title' });
  const input = el('input', { type: 'text', maxlength: 2000, autocomplete: 'off' });
  const send = el('button', { type: 'submit', class: 'btn' });
  const close = el('button', { type: 'button', class: 'ghost', onclick: () => { dialog.hidden = true; launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); } });
  const reset = el('button', { type: 'button', class: 'ghost', onclick: () => submit(t('cp_reset_message')) });
  const welcome = el('p', { class: 'muted' });
  transcript.append(welcome);
  const form = el('form', { onsubmit: (event) => { event.preventDefault(); submit(input.value); } }, input, send);
  const dialog = el('section', { id: 'copilot-dialog', class: 'cp-dialog', role: 'dialog', 'aria-labelledby': 'copilot-title', hidden: true },
    el('header', {}, title, reset, close), transcript, form);
  let busy = false, generation = 0;
  const entries = [];
  const openAsset = (case_id) => {
    window.dispatchEvent(new CustomEvent('agentbl:selectcase', { detail: { case_id } }));
  };
  function localize() {
    title.textContent = t('cp_title'); launcher.textContent = t('cp_title');
    input.placeholder = t('cp_placeholder'); input.setAttribute('aria-label', t('cp_placeholder'));
    send.textContent = t(busy ? 'cp_loading' : 'cp_send'); close.textContent = t('cp_close');
    reset.textContent = t('cp_reset'); welcome.textContent = t('cp_welcome');
    for (const entry of entries) if (entry.result) renderRecommendations(entry.cards, entry.result, { onSelect: openAsset });
  }
  async function submit(message) {
    if (busy || !String(message).trim()) return;
    busy = true; const requestGeneration = generation;
    input.value = ''; send.disabled = true; reset.disabled = true; localize();
    transcript.append(el('p', { class: 'cp-user' }, message));
    const narrative = el('p', { class: 'cp-narrative', role: 'status', 'aria-live': 'polite' }, t('cp_loading'));
    const cards = el('div', {}), entry = { cards, result: null };
    transcript.append(narrative, cards); entries.push(entry);
    try {
      const result = await copilotQuery(message, { onResult: (structured) => {
        if (requestGeneration !== generation) return;
        entry.result = structured; renderRecommendations(cards, structured, { onSelect: openAsset });
        narrative.textContent = t('cp_explaining');
      } });
      if (requestGeneration !== generation) return;
      narrative.textContent = result.narrative; entry.result = result;
      renderRecommendations(cards, result, { onSelect: openAsset });
      if (result.intent === 'PORTFOLIO') {
        const portfolio = await serverJson(`/api/investors/portfolio?wallet_address=${encodeURIComponent(state.wallet?.address || '0xDemoWallet')}`);
        if (requestGeneration !== generation) return;
        for (const item of portfolio.investments) cards.append(el('p', {}, `${item.label} · $${item.amountUsd.toLocaleString()} · ${t(`cp_source_${item.source_label}`)} · ${poolStateLabel(item.current_status)}`));
        if (!portfolio.investments.length) cards.append(el('p', {}, t('portfolio_empty')));
      }
    } catch (error) {
      if (requestGeneration !== generation) return;
      clear(cards);
      narrative.textContent = [404, 409].includes(error.status) ? t('cp_session_expired') : t('cp_error', { message: error.message });
    } finally {
      if (requestGeneration === generation) {
        busy = false; send.disabled = false; reset.disabled = false; localize();
        transcript.scrollTop = transcript.scrollHeight; input.focus();
      }
    }
  }
  launcher.addEventListener('click', () => {
    dialog.hidden = !dialog.hidden; launcher.setAttribute('aria-expanded', String(!dialog.hidden));
    if (!dialog.hidden) input.focus();
  });
  dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') close.click(); });
  window.addEventListener('agentbl:runtimechange', () => {
    generation += 1; resetCopilotSession(); busy = false; send.disabled = false; reset.disabled = false;
    entries.length = 0; clear(transcript); transcript.append(welcome); localize();
  });
  onLangChange(localize); localize(); document.body.append(launcher, dialog);
}
