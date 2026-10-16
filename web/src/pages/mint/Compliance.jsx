import { t } from '../../lib/i18n.js';
import { Disclosure } from '../../components/ui.jsx';

/** Localized, text-only screening evidence. A demo CLEAR is never called legal clearance. */
export function Compliance({ report }) {
  return (
    <Disclosure className="ebl-compliance" summary={`${t('comp_title')} · ${t(`comp_status_${report.status}`)}`}>
      <p className="muted">{`${t('comp_list')}: ${report.list_version} · ${t('comp_as_of')}: ${report.as_of}`}</p>
      <p className="cp-warning">{t('comp_disclaimer')}</p>
      {(report.checks ?? []).map((check, index) => {
        const code = `comp_code_${check.code}`, translated = t(code);
        const evidence = check.evidence ?? {};
        const facts = [
          evidence.document_name ? [t('comp_document'), evidence.document_name] : null,
          evidence.value ? [t('comp_value'), evidence.value] : null,
          evidence.matched_name ? [t('comp_match'), evidence.matched_name] : null,
          evidence.entry_id && typeof evidence.score === 'number' ? [t('comp_score'), `${(evidence.score * 100).toFixed(1)}%`] : null,
          evidence.country ? [t('comp_country'), evidence.country] : null,
          evidence.hs_prefix ? [t('comp_hs_prefix'), evidence.hs_prefix] : null,
          evidence.declared_standards?.length ? [t('comp_standards'), evidence.declared_standards.join(', ')] : null
        ].filter(Boolean);
        return (
          <div key={index} className="compliance-check">
            <strong>{`${t(`comp_category_${check.category}`)} · ${t(`comp_status_${check.status}`)}`}</strong>
            <p>{translated === code ? t('comp_code_INPUT_REVIEW') : translated}</p>
            {facts.length ? <dl className="field-list">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : null}
          </div>
        );
      })}
    </Disclosure>
  );
}
