// Voyage on a virtual clock (departure → ETA), the live RWA price and the in-transit incidents that
// make the AI reprice or pause the offering. The ship and the subscription bar are moved through
// refs on every animation frame, so the clock never re-renders the panel.
import { useEffect, useRef, useState } from 'react';
import { useApp, useLang, useStore } from '../../state/hooks.js';
import { liveQuote } from '../../state/app-store.js';
import { t, tData } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import { Badge, Button, Card, CardHead, Disclosure } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { RichT } from '../../components/RichText.jsx';
import { EVENTS, getOffering, relocalizeEvents, resetVoyage, simStore, syncSimulationCase, toggleEvent } from './simulation.js';

const PLAY_MS = 60000; // wall-clock ms to play the full voyage (0 → 100%)
const PAUSED = ['PAUSE_OFFERING', 'FREEZE_POOL', 'TRIGGER_LIQUIDATION'];

function initialProgress(caseData, dep, eta) {
  if (!dep || !eta) return 0.15;
  const dates = [...(caseData.shipment_events ?? []), ...(caseData.macro_risk_events ?? [])]
    .map((event) => +f.parseDate(event.date)).filter(Number.isFinite);
  const now = dates.length ? Math.max(...dates) : (+dep + (+eta - +dep) * 0.15);
  return Math.max(0.06, Math.min(0.9, f.voyageProgress(dep, eta, now)));
}

function waypoint(p, load, disch) {
  if (p <= 0.02) return t('wp_at_load', { load });
  if (p < 0.15) return t('wp_leaving', { load });
  if (p < 0.45) return t('wp_scs');
  if (p < 0.72) return t('wp_open');
  if (p < 0.97) return t('wp_approaching', { disch });
  return t('wp_arrived', { disch });
}

export function VoyageTab({ active }) {
  const state = useApp((s) => s);
  const lang = useLang();
  const caseData = state.caseData;
  const bl = caseData.bill_of_lading ?? {};
  const quote = liveQuote(state);
  const sim = useStore(simStore, (s) => s);
  useEffect(() => { syncSimulationCase(state.caseId, state.speed); }, [state.caseId, state.speed]);
  useEffect(() => { relocalizeEvents(); }, [lang]);

  const dep = f.parseDate(bl.shipped_on_board || bl.issue_date);
  const eta = f.parseDate(bl.eta);
  const clock = useRef({ progress: 0, playing: true, raf: 0, last: 0, caseId: null, pausedFill: null });
  const [playing, setPlaying] = useState(true);
  const refs = { ship: useRef(null), rail: useRef(null), tip: useRef(null), scrub: useRef(null), note: useRef(null), finBar: useRef(null), finLabel: useRef(null) };
  const quoteRef = useRef(quote);
  quoteRef.current = quote;

  if (clock.current.caseId !== state.caseId) {
    clock.current.caseId = state.caseId;
    clock.current.progress = initialProgress(caseData, dep, eta);
    clock.current.pausedFill = null;
  }

  const paint = () => {
    const p = clock.current.progress;
    if (refs.ship.current) refs.ship.current.style.left = `${2 + p * 96}%`;
    if (refs.rail.current) refs.rail.current.style.width = `${p * 100}%`;
    const when = f.fmtDateTime(f.dateAtProgress(dep, eta, p));
    const where = waypoint(p, tData(bl.port_of_loading) || '—', tData(bl.port_of_discharge) || '—');
    if (refs.tip.current) refs.tip.current.textContent = `${when} · ${where}`;
    if (refs.scrub.current && document.activeElement !== refs.scrub.current) refs.scrub.current.value = String(Math.round(p * 1000));
    if (refs.note.current) refs.note.current.textContent = p >= 1 ? t('eta_arrived') : t('eta_current', { when, pct: Math.round(p * 100) });
    // The subscription bar follows the virtual clock; a paused offering freezes it where it stood.
    const q = quoteRef.current;
    if (!q) return;
    const paused = PAUSED.includes(q.pricing_action);
    const target = q.expected_cash_to_exporter_usd || q.requested_cash_usd || 0;
    let fill;
    if (paused) {
      if (clock.current.pausedFill == null) clock.current.pausedFill = Math.min(1, 0.12 + p * 0.9);
      fill = clock.current.pausedFill;
    } else {
      clock.current.pausedFill = null;
      fill = Math.min(1, 0.12 + p * 0.9);
    }
    if (refs.finBar.current) {
      refs.finBar.current.style.width = `${fill * 100}%`;
      refs.finBar.current.classList.toggle('is-paused', paused);
    }
    if (refs.finLabel.current) refs.finLabel.current.textContent = `${f.usdCompact(Math.round(target * fill))} / ${f.usdCompact(target)} · ${Math.round(fill * 100)}%${paused ? t('fin_paused') : ''}`;
  };

  const paintRef = useRef(paint);
  paintRef.current = paint;
  // Repaint after every render (new quote, language, case) without restarting the clock.
  useEffect(() => { paintRef.current(); });
  useEffect(() => {
    if (!active) return undefined;
    const c = clock.current;
    c.last = performance.now();
    const tick = (ts) => {
      const dt = ts - c.last;
      c.last = ts;
      if (c.playing && c.progress < 1) {
        c.progress = Math.min(1, c.progress + dt / PLAY_MS);
        paintRef.current();
      }
      c.raf = requestAnimationFrame(tick);
    };
    c.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(c.raf);
  }, [active]);

  const togglePlay = () => {
    clock.current.playing = !clock.current.playing;
    clock.current.last = performance.now();
    setPlaying(clock.current.playing);
  };

  const voyageNo = bl.voyage_no ? t('voyage_voyage_no', { no: bl.voyage_no }) : '';
  return (
    <div className="voyage-tab">
      <Card className="voyage-card" aria-labelledby="voyage-h">
        <CardHead id="voyage-h" title={t('vp1_h')} level={3}>
          <span className="muted small"><RichT k="voyage_sub_vessel_short" vars={{ vessel: bl.vessel || '—', voyage: voyageNo, carrier: bl.carrier ? ` · ${bl.carrier}` : '' }} /></span>
        </CardHead>
        <div className="voyage">
          <div className="port">
            <span className="port-tag">{t('vp_dep')}</span>
            <strong>{tData(bl.port_of_loading) || '—'}</strong>
            <span className="muted small">{f.fmtDate(dep)}</span>
          </div>
          <div className="voyage-rail">
            <span className="rail-line" />
            <span className="rail-progress" ref={refs.rail} />
            <span className="ship" ref={refs.ship} tabIndex={0} role="img" aria-labelledby="ship-tooltip"><Icon name="ship" size={18} /></span>
            <span className="ship-tooltip" id="ship-tooltip" ref={refs.tip}>—</span>
          </div>
          <div className="port port-end">
            <span className="port-tag">{t('vp_arr')}</span>
            <strong>{tData(bl.port_of_discharge) || '—'}</strong>
            <span className="muted small">{f.fmtDate(eta)}</span>
          </div>
        </div>
        <div className="voyage-controls">
          <Button variant="ghost" size="sm" onClick={togglePlay}>
            <Icon name={playing ? 'pause' : 'play'} size={14} />{playing ? t('pause_label') : t('play_label')}
          </Button>
          <input
            ref={refs.scrub}
            className="scrubber"
            type="range"
            min="0"
            max="1000"
            defaultValue="0"
            aria-label={t('a11y_voyage_progress')}
            onInput={(event) => { clock.current.progress = Number(event.target.value) / 1000; paint(); }}
          />
          <span className="muted small" ref={refs.note} />
        </div>
      </Card>

      <div className="voyage-grid">
        <LivePrice quote={quote} />
        <Card className="fin-card" aria-labelledby="fin-h">
          <CardHead id="fin-h" title={t('fin_head')} level={3} />
          <div className="kv-grid">
            <div className="kv"><span className="kv-label">{t('live_risk_label')}</span><span className="kv-value"><Badge tone={f.riskTone(quote?.risk_level)}>{f.riskLabel(quote?.risk_level)}</Badge></span></div>
            <div className="kv"><span className="kv-label">{t('live_riskbps_label')}</span><span className="kv-value">{quote ? `${f.int(quote.risk_score_bps)} bps` : '—'}</span></div>
          </div>
          <div className="fin-block">
            <div className="progress"><span className="progress-fill fill-accent" ref={refs.finBar} /></div>
            <p className="muted small" ref={refs.finLabel} />
            <p className="muted small">{t('fin_virtual_note')}</p>
          </div>
        </Card>
      </div>

      <Callout />

      <Card aria-labelledby="events-h">
        <CardHead id="events-h" title={t('vp3_h')} level={3}>
          {state.voyageInjected ? <Button variant="ghost" size="sm" onClick={resetVoyage}>{t('reset_btn')}</Button> : null}
        </CardHead>
        <p className="muted small">{t('vp3_sub')}</p>
        <div className="event-btns" role="group" aria-label={t('vp3_h')}>
          {EVENTS.map((event) => {
            const on = sim.applied.includes(event.key);
            return (
              <button key={event.key} type="button" className={`event-btn tone-${event.tone}${on ? ' is-active' : ''}`} aria-pressed={on} disabled={sim.pending} onClick={() => toggleEvent(event.key)}>
                {on ? <Icon name="check" size={14} /> : null}{t(event.labelKey)}
              </button>
            );
          })}
        </div>
        {sim.worldRiskApplied ? <p className="muted small">{t('wr_applied_note')}</p> : null}
        <Lifecycle />
      </Card>
    </div>
  );
}

function LivePrice({ quote }) {
  const [flash, setFlash] = useState(null);
  const last = useRef(null);
  const price = quote?.final_issue_price_usd;
  useEffect(() => {
    if (price == null) return undefined;
    const previous = last.current;
    last.current = price;
    if (previous == null || Math.abs(price - previous) <= 1e-6) return undefined;
    setFlash(price < previous ? 'flash-down' : 'flash-up');
    const timer = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(timer);
  }, [price]);
  if (!quote) return <Card><p className="muted">—</p></Card>;
  const act = f.actionMeta(quote.pricing_action);
  return (
    <Card className="live-price-card" aria-labelledby="live-h">
      <CardHead id="live-h" title={t('live_price_label')} level={3} />
      <div className={`price-xl live-price${flash ? ` ${flash}` : ''}`} id="live-price" aria-live="polite">${f.price(price)}</div>
      <div className="live-meta">
        <Badge tone={act.tone}>{`${act.icon} ${act.label}`}</Badge>
        <span className="small"><strong className="text-gain">{f.bpsToPct(quote.implied_gross_yield_bps)}</strong> {t('live_upside')}</span>
      </div>
    </Card>
  );
}

function Callout() {
  const injected = useApp((s) => s.voyageInjected);
  const off = useApp((s) => s.voyageOffering);
  if (!injected || !off?.initial_quote || !off?.final_quote) return null;
  const initial = off.initial_quote, finalQ = off.final_quote;
  const paused = ['Paused', 'Frozen', 'Liquidation'].includes(off.final_state);
  const dropped = finalQ.final_issue_price_usd < initial.final_issue_price_usd;
  const text = paused
    ? t('co_paused', { level: f.riskLabel(finalQ.risk_level), hash: f.shortHash(finalQ.evidence_hash) })
    : dropped
      ? t('co_repriced', { level: f.riskLabel(finalQ.risk_level), a: f.price(initial.final_issue_price_usd), b: f.price(finalQ.final_issue_price_usd), y: f.bpsToPct(finalQ.implied_gross_yield_bps) })
      : t('co_held', { level: f.riskLabel(finalQ.risk_level), p: f.price(finalQ.final_issue_price_usd) });
  return <div className={`callout tone-${paused ? 'crit' : dropped ? 'warn' : 'info'}`} role="status"><Icon name={paused ? 'alert' : 'info'} size={16} />{text}</div>;
}

function Lifecycle() {
  const caseId = useApp((s) => s.caseId);
  const speed = useApp((s) => s.speed);
  const offeringKey = useApp((s) => s.voyageOffering);
  const [data, setData] = useState({ offering: null, error: null });
  useEffect(() => {
    let current = true;
    getOffering().then((offering) => { if (current) setData({ offering, error: null }); }, (error) => { if (current) setData({ offering: null, error: error.message }); });
    return () => { current = false; };
  }, [caseId, speed, offeringKey]);
  if (data.error) return <p className="text-crit">{t('lc_fail', { msg: data.error })}</p>;
  if (!data.offering) return <p className="muted small">{t('wr_loading_short')}</p>;
  const reached = new Set(data.offering.steps.map((step) => step.state));
  const endState = data.offering.final_state;
  const seq = f.LIFECYCLE.filter((s) => (s === 'Repriced' ? reached.has('Repriced') : s === 'Paused' ? reached.has('Paused') || endState === 'Paused' : true));
  return (
    <div className="lifecycle-wrap">
      <ol className="lifecycle" aria-label={t('lc_label')}>
        {seq.map((s) => {
          const on = reached.has(s) || s === endState;
          return (
            <li key={s} className={`lc-node tone-${on ? f.stateTone(s) : 'muted'}${on ? ' is-on' : ''}${s === endState ? ' is-end' : ''}`} aria-current={s === endState ? 'step' : undefined}>
              <span className="lc-dot" aria-hidden="true" /><span className="lc-name">{s}</span>
            </li>
          );
        })}
      </ol>
      <Disclosure summary={t('lc_timeline_summary', { n: data.offering.steps.length })}>
        <ol className="timeline">
          {data.offering.steps.map((step, index) => (
            <li key={index} className={`tl-item tone-${f.stateTone(step.state)}`}>
              <Badge tone={f.stateTone(step.state)}>{step.state}</Badge>
              <span className="muted small">{step.actor}</span>
              <p>{step.event}</p>
            </li>
          ))}
        </ol>
      </Disclosure>
    </div>
  );
}
