import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../state/hooks.js';
import { appStore } from '../../state/app-store.js';
import { t } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import { CATEGORIES, MARKET_SORTS, marketStats, sortMarketCases, visibleCases } from '../../lib/market.js';
import { scrollBehavior } from '../../lib/accessibility.js';
import {
  clearAiSearch, ensureComparisons, replaceSearchResult, runAiSearch, selectCase, setCategory, setMarketSort, setSearchQuery
} from '../../state/controller.js';
import { Button, Empty, Stat } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Recommendations } from '../../features/copilot/Recommendations.jsx';
import { useNow } from '../../hooks/useNow.js';
import { ProjectCard } from './ProjectCard.jsx';
import { DetailPanel } from './DetailPanel.jsx';
import { PortfolioDialog } from './PortfolioDialog.jsx';

export function MarketPage() {
  const state = useApp((s) => s);
  const now = useNow(60_000);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const cases = useMemo(() => sortMarketCases(state, visibleCases(state)), [state]);
  const stats = useMemo(() => marketStats(state, cases), [state, cases]);
  const visibleIds = cases.map((entry) => entry.case_id).join('|');

  useEffect(() => {
    ensureComparisons(visibleCases(appStore.get()));
  }, [visibleIds]);

  // A linked decision asked to show its project card.
  const focusRequest = state.focusRequest;
  useEffect(() => {
    if (focusRequest?.target !== 'market') return;
    const node = document.querySelector(`[data-case="${CSS.escape(focusRequest.caseId)}"]`);
    node?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    node?.focus({ preventScroll: true });
  }, [focusRequest]);

  const holdings = (state.portfolio.investments?.length ?? 0) + (state.portfolio.positions?.filter((position) => position.mode === 'live').length ?? 0);
  return (
    <div className="market">
      <header className="page-head">
        <div className="page-head-text">
          <p className="eyebrow">{t('market_eyebrow')}</p>
          <h1 id="market-title">{t('market_h1')}</h1>
          <p className="page-sub">{t('market_subtitle_short')}</p>
        </div>
        <div className="page-head-stats" aria-live="polite">
          <Stat label={t('market_stat_open')} value={`${stats.open} / ${stats.priced}`} />
          <Stat label={t('market_stat_target')} value={f.usdCompact(stats.target)} />
          <Stat label={t('market_stat_yield')} value={stats.avgYield == null ? '—' : f.bpsToPct(stats.avgYield)} />
          <Button variant="secondary" className="portfolio-btn" onClick={() => setPortfolioOpen(true)} aria-haspopup="dialog">
            <Icon name="briefcase" size={15} />{t('portfolio_h')}{holdings ? <span className="count-pill">{holdings}</span> : null}
          </Button>
        </div>
      </header>

      <MarketToolbar />

      {state.aiResult ? (
        <section className="ai-results card" aria-label="Copilot" aria-live="polite">
          <header className="ai-results-head">
            <div>
              <h2 className="card-title"><Icon name="sparkle" size={16} />{t('ai_results_title')}</h2>
              <p className="muted small">{t('ai_results_hint', { n: state.aiResult.recommendations?.length ?? 0 })}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={clearAiSearch}>{t('ai_results_clear')}</Button>
          </header>
          <Recommendations result={state.aiResult} scope="search" onSelect={selectCase} onRefresh={replaceSearchResult} />
        </section>
      ) : null}

      <div className="market-layout">
        <section className="market-board" aria-labelledby="market-board-title">
          <div className="board-head">
            <h2 id="market-board-title" className="section-title">{t('market_board_h')}</h2>
            <span className="muted small" aria-live="polite">{t('market_count', { n: cases.length })}{state.marketLoading ? ` · ${t('market_loading')}` : ''}</span>
          </div>
          {!state.cases.length && !state.casesError ? <Empty>{t('market_cases_loading')}</Empty> : cases.length ? (
            <div className="deal-grid">
              {cases.map((entry) => <ProjectCard key={entry.case_id} entry={entry} state={state} now={now} />)}
            </div>
          ) : <Empty title={t('market_empty')}>{t('market_empty_hint')}</Empty>}
        </section>
        <aside className="market-aside" aria-label={t('a11y_selected_project')}>
          <DetailPanel now={now} />
        </aside>
      </div>
      <PortfolioDialog open={portfolioOpen} onClose={() => setPortfolioOpen(false)} />
    </div>
  );
}

const SORT_LABELS = {
  recommended: 'market_sort_recommended', yield_desc: 'market_sort_yield', risk_asc: 'market_sort_risk',
  funding_desc: 'market_sort_funding', eta_asc: 'market_sort_eta'
};

function MarketToolbar() {
  const category = useApp((s) => s.categoryFilter);
  const sort = useApp((s) => s.marketSort);
  const searchQuery = useApp((s) => s.searchQuery);
  const aiSearching = useApp((s) => s.aiSearching);
  const aiActive = useApp((s) => Boolean(s.aiResult));
  const [text, setText] = useState(searchQuery);
  const debounce = useRef(null);
  // A cleared filter (reset, linked decision) empties the box too.
  useEffect(() => { if (!searchQuery) setText(''); }, [searchQuery]);
  useEffect(() => () => clearTimeout(debounce.current), []);
  const onInput = (value) => {
    setText(value);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setSearchQuery(value), 300);
  };
  return (
    <div className="toolbar" role="search">
      <div className="chip-group" role="group" aria-label={t('market_category_label')}>
        {CATEGORIES.map((name) => (
          <button key={name} type="button" className={`chip-btn${category === name ? ' is-active' : ''}`} aria-pressed={category === name} onClick={() => setCategory(name)}>
            {t(`cat_${name}`)}
          </button>
        ))}
      </div>
      <label className="sort-field">
        <span className="sr-only">{t('market_sort_label')}</span>
        <select className="select select-sm" value={sort} onChange={(event) => setMarketSort(event.target.value)} disabled={aiActive} title={aiActive ? t('market_sort_ai_hint') : undefined}>
          {MARKET_SORTS.map((name) => <option key={name} value={name}>{`${t('market_sort_label')}: ${t(SORT_LABELS[name])}`}</option>)}
        </select>
      </label>
      <form className="search" onSubmit={(event) => { event.preventDefault(); clearTimeout(debounce.current); runAiSearch(text); }}>
        <Icon name="search" size={16} className="search-icon" />
        <input
          id="search-input"
          className="search-input"
          type="search"
          value={text}
          placeholder={t('search_ph')}
          aria-label={t('search_ph')}
          onChange={(event) => onInput(event.target.value)}
        />
        <Button type="submit" variant="primary" size="sm" disabled={aiSearching} title={t('ai_search_title')}>
          <Icon name="sparkle" size={14} />{aiSearching ? t('ai_searching') : t('ai_parse')}
        </Button>
      </form>
    </div>
  );
}
