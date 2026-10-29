import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useAppPick, useLang } from '../../state/hooks.js';
import { appStore } from '../../state/app-store.js';
import { t } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import { MARKET_SORTS, categoryOptions, duplicateLabelIds, marketStats, sortMarketCases, visibleCases } from '../../lib/market.js';
import { scrollBehavior } from '../../lib/accessibility.js';
import { useStickyFit } from '../../hooks/useStickyFit.js';
import { SINGLE_COLUMN, useMediaQuery } from '../../hooks/useMediaQuery.js';
import { PageIntro } from '../../components/PageIntro.jsx';
import {
  clearAiSearch, ensureComparisons, keepSelectionVisible, replaceSearchResult, resetMarketFilters, runAiSearch, selectCase, setCategory, setMarketSort, setSearchQuery
} from '../../state/controller.js';
import { Button, Empty, Stat, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Recommendations } from '../../features/copilot/Recommendations.jsx';
import { useNow } from '../../hooks/useNow.js';
import { DETAIL_SHEET_REQUEST, ProjectCard } from './ProjectCard.jsx';
import { DetailPanel } from './DetailPanel.jsx';
import { PortfolioDialog } from './PortfolioDialog.jsx';

// Everything MarketPage, ProjectCard and the market helpers (visibleCases, sortMarketCases, marketStats, marketView) read.
const MARKET_STATE = [
  'cases', 'casesError', 'caseId', 'categoryFilter', 'searchQuery', 'marketSort', 'aiMatchedIds', 'aiRanks', 'aiResult', 'marketLoading',
  'marketComparisons', 'evidencePools', 'evidenceSelected', 'focusRequest', 'portfolio', 'demoMode'
];

export function MarketPage() {
  const state = useAppPick(MARKET_STATE);
  useLang();
  const now = useNow(60_000);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const aside = useRef(null);
  useStickyFit(aside);
  // One column (phones, narrow windows): the detail is a sheet over the shelf, opened by a card, instead of a
  // second screenful after every card. The introduction folds away on a phone so the projects start near the top.
  const singleColumn = useMediaQuery(SINGLE_COLUMN);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheet = singleColumn ? (sheetOpen ? 'open' : 'closed') : null;
  useEffect(() => {
    const open = () => setSheetOpen(true);
    window.addEventListener(DETAIL_SHEET_REQUEST, open);
    return () => window.removeEventListener(DETAIL_SHEET_REQUEST, open);
  }, []);
  useEffect(() => { if (!singleColumn) setSheetOpen(false); }, [singleColumn]);
  useEffect(() => {
    if (sheet !== 'open') return undefined;
    aside.current?.focus({ preventScroll: true });
    document.documentElement.classList.add('has-sheet');
    return () => document.documentElement.classList.remove('has-sheet');
  }, [sheet]);
  const closeSheet = () => { setSheetOpen(false); returnToCard(state.caseId); };
  // Search includes translated fields, so derive the small catalog on both language and store renders.
  const cases = sortMarketCases(state, visibleCases(state));
  const selectionVisible = cases.some((entry) => entry.case_id === state.caseId);
  const stats = useMemo(() => marketStats(state, cases), [state, cases]);
  const visibleIds = cases.map((entry) => entry.case_id).join('|');
  const lookalikes = useMemo(() => duplicateLabelIds(state.cases), [state.cases]);

  useEffect(() => {
    keepSelectionVisible();
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
          <PageIntro summary={t('market_intro_more')}>
            <p className="page-sub">{t('market_subtitle_short')}</p>
            {/* Sample statistics of fictional research cases are context, not the task: one quiet line, with what they are. */}
            <p className="muted small market-sample-stats" aria-live="polite">
              {`${t('market_stat_target')} ${f.usdCompact(stats.target)} (${t('market_stat_sample_hint')}) · ${t('market_stat_yield')} ${stats.avgYield == null ? '—' : f.bpsToPct(stats.avgYield)} (${t('market_stat_yield_hint')})`}
            </p>
          </PageIntro>
        </div>
        <div className="page-head-stats" aria-live="polite">
          <Stat label={t('market_stat_open')} value={`${stats.open} / ${stats.priced}`} />
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
              {cases.map((entry) => <ProjectCard key={entry.case_id} entry={entry} state={state} now={now} tagged={lookalikes.has(entry.case_id)} />)}
            </div>
          ) : (
            <Empty title={t('market_empty')} action={<Button variant="secondary" size="sm" onClick={resetMarketFilters}>{t('market_filters_reset')}</Button>}>
              {t('market_empty_hint')}
            </Empty>
          )}
        </section>
        {sheet === 'open' ? <div className="sheet-backdrop" aria-hidden="true" onClick={closeSheet} /> : null}
        <aside
          ref={aside}
          className={cx('market-aside', sheet && 'is-sheet', sheet === 'open' && 'is-open')}
          aria-label={t('a11y_selected_project')}
          hidden={sheet === 'closed'}
          {...(sheet ? { role: 'dialog', 'aria-modal': 'true', tabIndex: -1, onKeyDown: (event) => sheetKeys(event, closeSheet) } : {})}
        >
          {/* Single column: the detail is a sheet over the shelf; closing it returns to the chosen card. */}
          {sheet ? (
            <div className="sheet-bar">
              <span className="sheet-grip" aria-hidden="true" />
              <Button variant="ghost" size="sm" className="market-back" onClick={closeSheet}>
                <Icon name="arrowUp" size={14} />{t('market_back_to_card')}
              </Button>
            </div>
          ) : null}
          <DetailPanel now={now} noMatches={!cases.length && state.cases.length > 0} selectionVisible={selectionVisible} />
        </aside>
      </div>
      <PortfolioDialog open={portfolioOpen} onClose={() => setPortfolioOpen(false)} />
    </div>
  );
}

/** In the detail sheet Escape closes it and Tab cycles through its own controls, as in any modal dialog. */
function sheetKeys(event, close) {
  if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...event.currentTarget.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]')]
    .filter((node) => node.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function returnToCard(caseId) {
  const node = document.querySelector(`[data-case="${CSS.escape(caseId ?? '')}"]`);
  node?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  node?.focus({ preventScroll: true });
}

const SORT_LABELS = {
  recommended: 'market_sort_recommended', yield_desc: 'market_sort_yield', risk_asc: 'market_sort_risk',
  funding_desc: 'market_sort_funding', eta_asc: 'market_sort_eta'
};

// What the category chips need: every case (which categories exist) and the search (match counts).
const TOOLBAR_STATE = ['cases', 'searchQuery', 'aiMatchedIds', 'aiRanks'];

function MarketToolbar() {
  const toolbarState = useAppPick(TOOLBAR_STATE);
  useLang();
  const options = categoryOptions(toolbarState);
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
        {options.map(({ name, count }) => (
          <button key={name} type="button" className={`chip-btn${category === name ? ' is-active' : ''}`} aria-pressed={category === name} onClick={() => setCategory(name)}>
            {t(`cat_${name}`)}<span className="chip-count">{count}</span>
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
