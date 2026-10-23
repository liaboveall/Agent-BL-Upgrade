// Investor Copilot: the server owns context, retrieval, ranking and explanations. This dialog renders
// the results and opens asset panels; a message never executes a transaction (actions need the
// card's own Confirm).
import { useEffect, useRef, useState } from 'react';
import { useLang } from '../../state/hooks.js';
import { t, tData, tTradeText } from '../../lib/i18n.js';
import { copilotQuery, resetCopilotSession } from '../../lib/copilot-api.js';
import { portfolioPath, serverJson } from '../../lib/assistant-tools.js';
import { Button, Dialog, DialogHeader } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { usd2 } from '../../lib/format.js';
import { Recommendations, poolStateLabel } from './Recommendations.jsx';

export function CopilotLauncher() {
  useLang();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const generation = useRef(0);
  const transcript = useRef(null);
  const field = useRef(null);
  const launcher = useRef(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const onScroll = () => setCompact(window.scrollY > 160);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const update = (id, patch) => setEntries((list) => list.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

  useEffect(() => {
    const onRuntime = () => { generation.current += 1; resetCopilotSession(); setBusy(false); setEntries([]); };
    const onUpdate = ({ detail }) => {
      if (detail.scope !== 'assistant') return;
      setEntries((list) => {
        const last = list.at(-1), next = detail.update;
        if (!last?.result || last.busy || last.result.context.session_id !== next.result.context.session_id) return list;
        return [...list.slice(0, -1), { ...last, result: { ...next.result, rerank: next }, narrativeKey: 'cp_current_update' }];
      });
    };
    window.addEventListener('agentbl:runtimechange', onRuntime);
    window.addEventListener('agentbl:copilotupdate', onUpdate);
    return () => { window.removeEventListener('agentbl:runtimechange', onRuntime); window.removeEventListener('agentbl:copilotupdate', onUpdate); };
  }, []);

  useEffect(() => { if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; }, [entries]);
  useEffect(() => { if (open) requestAnimationFrame(() => field.current?.focus()); }, [open]);

  const submit = async (message) => {
    const text = String(message ?? '').trim();
    if (busy || !text) return;
    const requestGeneration = generation.current, id = `${Date.now()}`;
    setBusy(true); setInput('');
    setEntries((list) => [...list, { id, message: text, busy: true, narrative: null, narrativeKey: 'cp_loading', result: null, portfolio: null, error: null }]);
    try {
      const result = await copilotQuery(text, { onResult: (structured) => {
        if (requestGeneration === generation.current) update(id, { result: structured, narrativeKey: 'cp_explaining' });
      } });
      if (requestGeneration !== generation.current) return;
      update(id, { result, narrative: result.narrative, narrativeKey: null });
      if (result.intent === 'PORTFOLIO') {
        const portfolio = await serverJson(portfolioPath());
        if (requestGeneration === generation.current) update(id, { portfolio: portfolio.investments });
      }
    } catch (error) {
      if (requestGeneration !== generation.current) return;
      update(id, { result: null, narrativeKey: null, error: [404, 409].includes(error.status) ? t('cp_session_expired') : t('cp_error', { message: error.message }) });
    } finally {
      if (requestGeneration === generation.current) {
        update(id, { busy: false });
        setBusy(false);
        if (document.activeElement === field.current || !document.activeElement || document.activeElement === document.body) field.current?.focus();
      }
    }
  };

  const openAsset = (caseId) => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent('agentbl:selectcase', { detail: { case_id: caseId } }));
  };

  return (
    <>
      <button ref={launcher} type="button" className={`cp-launcher${compact ? ' is-compact' : ''}`} aria-controls="copilot-dialog" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="message" size={16} /><span className="cp-launcher-label">{t('cp_title')}</span>
      </button>
      <Dialog id="copilot-dialog" open={open} onClose={() => setOpen(false)} labelledBy="copilot-title" variant="side" className="cp-dialog">
        <div className="cp-shell">
          <DialogHeader id="copilot-title" title={t('cp_title')} subtitle={t('cp_subtitle')} onClose={() => setOpen(false)}>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => submit(t('cp_reset_message'))}>{t('cp_reset')}</Button>
          </DialogHeader>
          <div ref={transcript} className="cp-transcript">
            <p className="muted">{t('cp_welcome')}</p>
            {entries.map((entry) => (
              <div key={entry.id} className="cp-entry">
                <p className="cp-user">{entry.message}</p>
                <p className="cp-narrative" role="status" aria-live="polite">
                  {entry.error ?? (entry.narrativeKey ? t(entry.narrativeKey) : tTradeText(entry.narrative))}
                </p>
                {entry.result ? (
                  <Recommendations result={entry.result} scope="assistant" onSelect={openAsset}
                    onRefresh={(result) => update(entry.id, { result, narrative: result.narrative, narrativeKey: null })} />
                ) : null}
                {entry.portfolio ? (
                  entry.portfolio.length
                    ? entry.portfolio.map((item, index) => <p key={index}>{`${tData(item.label)} · ${usd2(item.amountUsd)} · ${t(`cp_source_${item.source_label}`)} · ${poolStateLabel(item.current_status)}`}</p>)
                    : <p>{t('portfolio_empty')}</p>
                ) : null}
              </div>
            ))}
          </div>
          <form className="cp-form" onSubmit={(event) => { event.preventDefault(); submit(input); }}>
            <input ref={field} className="input" type="text" maxLength={2000} autoComplete="off" value={input} placeholder={t('cp_placeholder')} aria-label={t('cp_placeholder')}
              onChange={(event) => setInput(event.target.value)} />
            <Button type="submit" variant="primary" disabled={busy}>{busy ? t('cp_loading') : t('cp_send')}</Button>
          </form>
        </div>
      </Dialog>
    </>
  );
}
