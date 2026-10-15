import { COMPLIANCE_DATA, validImo } from './data.js';
import { matchEntity, normalizeEntity } from './matcher.js';
import { normalizeForScreening, screenDocumentText } from '../ingest/injectionScreen.js';

export const MATCH_THRESHOLDS = Object.freeze({ block: 0.92, review: 0.85 });
const ORDER = { CLEAR: 0, REVIEW: 1, BLOCK: 2 };
export const worstStatus = (statuses) => statuses.reduce((worst, status) => ORDER[status] > ORDER[worst] ? status : worst, 'CLEAR');
export const COMPLIANCE_DISCLAIMER = `Screened against bundled demo list ${COMPLIANCE_DATA.list.version} (as of ${COMPLIANCE_DATA.list.as_of}); not an OFAC/UN/EU list screening and not a legal determination.`;

export function complianceReport(checks, data = COMPLIANCE_DATA, extra = {}) {
  const status = worstStatus(checks.map((check) => check.status));
  return {
    ...extra, status, checks, list_version: data.list.version, as_of: data.list.as_of,
    ports_version: data.locations.version, data_hash: data.hash, source: 'bundled-demo',
    disclaimer: `Screened against bundled demo list ${data.list.version} (as of ${data.list.as_of}); not an OFAC/UN/EU list screening and not a legal determination.`,
    // Keep the public boolean contract for existing consumers; checks now use the v2 statuses.
    ok: status !== 'BLOCK', has_block: status === 'BLOCK', has_warning: checks.some((check) => check.status === 'REVIEW'),
    issues: checks.filter((check) => check.status !== 'CLEAR').map((check) => `[${check.status}] ${check.label}: ${check.detail}`)
  };
}

const normalizeLocation = (value) => normalizeForScreening(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Explicit codes or bounded aliases only. Conflicting locations are retained for review. */
export function resolvePort(value, locations = COMPLIANCE_DATA.locations) {
  if (typeof value !== 'string' || value.length > 600) return [];
  const text = normalizeLocation(value);
  return locations.ports.filter((port) => [port.id, ...port.aliases].some((alias) => {
    const normalized = normalizeLocation(alias);
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(normalized)}(?:$|[^\\p{L}\\p{N}])`, 'u').test(text);
  }));
}

/** Return all supplied facts, including invoice parties, rather than trusting the case summary. */
export function complianceFacts(caseData = {}, { documents = [] } = {}) {
  const facts = [];
  const from = (section, names, category) => {
    for (const name of names) if (caseData[section]?.[name] !== undefined && caseData[section]?.[name] !== null) {
      facts.push({ category, field: `${section}.${name}`, value: caseData[section][name] });
    }
  };
  from('caseEntry', ['buyer', 'seller'], 'entity');
  from('bill_of_lading', ['shipper', 'consignee', 'notify_party', 'carrier'], 'entity');
  from('commercial_invoice', ['buyer', 'seller'], 'entity');
  from('warehouse_receipt', ['shipper', 'consignee', 'warehouse_operator'], 'entity');
  from('insurance', ['provider', 'insured_party'], 'entity');
  for (const section of ['bill_of_lading', 'commercial_invoice']) {
    from(section, ['port_of_loading', 'port_of_discharge'], 'port');
    from(section, ['vessel_imo', 'imo'], 'imo');
    from(section, ['vessel'], 'vessel');
  }
  from('warehouse_receipt', ['warehouse'], 'port');
  if (caseData.bill_of_lading?.transshipment_ports !== undefined) {
    const ports = caseData.bill_of_lading.transshipment_ports;
    if (Array.isArray(ports) && ports.length <= 20) ports.forEach((value, i) => facts.push({ category: 'port', field: `bill_of_lading.transshipment_ports.${i}`, value }));
    else facts.push({ category: 'port', field: 'bill_of_lading.transshipment_ports', value: null });
  }
  for (const section of ['cargo', 'bill_of_lading', 'commercial_invoice', 'warehouse_receipt', 'caseEntry']) from(section, ['hs_code'], 'hs');
  from('caseEntry', ['cargo'], 'cargo'); from('bill_of_lading', ['cargo'], 'cargo');
  from('cargo', ['commodity'], 'cargo'); from('warehouse_receipt', ['cargo'], 'cargo');
  from('bill_of_lading', ['ebl_platform'], 'standard'); from('warehouse_receipt', ['ebl_platform'], 'standard');
  // Keep each parsed source, even if another document of the same type overwrites the merged case.
  documents.forEach((document, index) => {
    for (const fact of complianceFacts(document.case_fragment ?? {})) facts.push({ ...fact,
      field: `documents.${index}.${fact.field}`, document_name: document.source?.filename ?? null });
  });
  return facts;
}

export function checkCompliance(caseData = {}, { data = COMPLIANCE_DATA, documents = [] } = {}) {
  const checks = [], facts = complianceFacts(caseData, { documents });
  const add = (category, field, status, code, detail, value = null, extra = {}) => {
    checks.push({ id: `${category}:${field}`, category, label: category, status, code, detail,
      evidence: { list_version: data.list.version, field, entry_id: null, score: null,
        value: typeof value === 'string' ? value.slice(0, 600) : null,
        ...(facts.find((fact) => fact.field === field)?.document_name ? { document_name: facts.find((fact) => fact.field === field).document_name } : {}), ...extra } });
  };
  const safeFacts = [];
  for (const fact of facts) {
    if (typeof fact.value !== 'string' || !fact.value.trim() || fact.value.length > 600) {
      add(fact.category, fact.field, 'REVIEW', 'INPUT_REVIEW', 'A screening field is empty, malformed or exceeds the supported length.'); continue;
    }
    if (screenDocumentText(fact.value).suspicious) {
      add(fact.category, fact.field, 'REVIEW', 'INJECTION_REVIEW', 'Suspected instructions in a trade field; no instructions were followed.', fact.value); continue;
    }
    if (fact.category === 'entity' && !normalizeEntity(fact.value)) {
      add('entity', fact.field, 'REVIEW', 'INPUT_REVIEW', 'The name contains no screening tokens.', fact.value); continue;
    }
    safeFacts.push(fact);
  }
  if (!facts.some((fact) => fact.category === 'entity')) add('entity', 'counterparties', 'REVIEW', 'COUNTERPARTY_MISSING', 'No counterparties were supplied for screening.');
  for (const fact of safeFacts.filter((item) => item.category === 'entity' || item.category === 'vessel')) {
    const match = matchEntity(fact.value, fact.category === 'vessel' ? data.list.vessels : data.list.entities);
    const status = match?.score >= MATCH_THRESHOLDS.block ? 'BLOCK' : match?.score >= MATCH_THRESHOLDS.review ? 'REVIEW' : 'CLEAR';
    const prefix = fact.category === 'vessel' ? 'VESSEL' : 'ENTITY';
    add(fact.category, fact.field, status, status === 'CLEAR' ? `${prefix}_CLEAR` : `${prefix}_MATCH_${status}`,
      status === 'CLEAR' ? 'No matching entry in the bundled demo list; this does not prove legal eligibility.' : `Matched a fictional entry in demo list ${data.list.version}.`, fact.value,
      { entry_id: status === 'CLEAR' ? null : match.entry.id, score: match?.score ?? 0,
        ...(status === 'CLEAR' ? {} : { matched_name: match.alias }), token_jaccard: match?.token_jaccard ?? 0, jaro_winkler: match?.jaro_winkler ?? 0 });
  }
  for (const fact of safeFacts.filter((item) => item.category === 'port')) {
    const ports = resolvePort(fact.value, data.locations);
    const countries = [...new Set(ports.map((port) => port.country))];
    // Any recognized restricted port still blocks even if another location creates ambiguity.
    const restricted = ports.map((port) => ({ port, entry: data.list.jurisdictions.find((entry) => entry.country === port.country) })).filter((item) => item.entry);
    if (restricted.length) {
      for (const { port, entry } of restricted) add('jurisdiction', fact.field, 'BLOCK', 'JURISDICTION_BLOCK', 'The supplied location matches a demo jurisdiction rule; official rules and exemptions were not assessed.', fact.value,
        { entry_id: entry.id, country: entry.country, port_id: port.id, ports_version: data.locations.version, score: 1 });
    } else if (countries.length !== 1) {
      add('jurisdiction', fact.field, 'REVIEW', ports.length ? 'PORT_AMBIGUOUS' : 'PORT_UNKNOWN', 'The bundled location lookup cannot determine a single country.', fact.value,
        { countries, ports_version: data.locations.version });
    } else {
      add('jurisdiction', fact.field, 'CLEAR', 'PORT_CLEAR', 'Location mapped; its country is not in the bundled demo jurisdiction rules.', fact.value,
        { country: countries[0], port_id: ports[0].id, ports_version: data.locations.version, score: 1 });
    }
  }
  if (caseData.bill_of_lading && caseData.bill_of_lading.bl_type !== 'electronic_warehouse_receipt') {
    for (const name of ['port_of_loading', 'port_of_discharge']) if (!facts.some((fact) => fact.field === `bill_of_lading.${name}`)) {
      add('jurisdiction', `bill_of_lading.${name}`, 'REVIEW', 'PORT_MISSING', 'A required transport location was not supplied.');
    }
  }
  for (const fact of safeFacts.filter((item) => item.category === 'imo')) {
    const imo = fact.value.trim().replace(/^IMO\s*/iu, '');
    if (!validImo(imo)) { add('vessel', fact.field, 'REVIEW', 'IMO_INVALID', 'IMO format or checksum is invalid.', fact.value); continue; }
    const entry = data.list.vessels.find((vessel) => vessel.imo === imo);
    add('vessel', fact.field, entry ? 'BLOCK' : 'CLEAR', entry ? 'VESSEL_MATCH_BLOCK' : 'VESSEL_CLEAR',
      entry ? 'IMO matches a synthetic vessel entry in the demo list.' : 'No IMO match in the bundled demo vessel list.', fact.value, { entry_id: entry?.id ?? null, score: entry ? 1 : 0, imo });
  }
  const hsFacts = safeFacts.filter((item) => item.category === 'hs');
  if (!facts.some((fact) => fact.category === 'hs')) add('export_controls', 'cargo.hs_code', 'REVIEW', 'HS_MISSING', 'No HS code was supplied; no export-control classification can be inferred.');
  for (const fact of hsFacts) {
    const hs = fact.value.trim().replace(/[.\s]/gu, '');
    if (!/^\d{6,10}$/u.test(hs)) { add('export_controls', fact.field, 'REVIEW', 'HS_INVALID', 'HS code must contain 6 to 10 digits.', fact.value); continue; }
    const rules = data.list.hs_rules.filter((rule) => hs.startsWith(rule.prefix));
    if (!rules.length) add('export_controls', fact.field, 'CLEAR', 'HS_CLEAR', 'No bundled demo HS prefix matched; this is not an ECCN, EAR99 or licensing determination.', fact.value);
    for (const rule of rules) add('export_controls', fact.field, rule.status, rule.status === 'BLOCK' ? 'HS_BLOCK' : 'HS_REVIEW',
      'HS prefix matched an illustrative demo rule; classification and end-use require human verification.', fact.value,
      { entry_id: rule.id, hs_prefix: rule.prefix, hs_category: rule.category, score: 1 });
  }
  // A dangerous cargo declaration must not be cleared by an innocuous or conflicting HS code.
  for (const fact of safeFacts.filter((item) => item.category === 'cargo')) {
    const text = normalizeForScreening(fact.value).toLowerCase();
    if (/\b(?:military|weapons?|munitions?)\b|军品|武器|军用/u.test(text)) {
      add('export_controls', fact.field, 'BLOCK', 'CARGO_BLOCK', 'Cargo declares military goods; blocked by a demo declaration rule.', fact.value, { entry_id: 'DEMO-CARGO-MILITARY' });
    } else if (/\b(?:dual[ -]use|semiconductors?|chips?)\b|两用|半导体/u.test(text)) {
      add('export_controls', fact.field, 'REVIEW', 'CARGO_REVIEW', 'Cargo declares potentially dual-use goods; human classification is required.', fact.value, { entry_id: 'DEMO-CARGO-DUAL-USE' });
    }
  }
  const platformFacts = safeFacts.filter((item) => item.category === 'standard');
  const declared = new Set();
  for (const fact of platformFacts) for (const [id, re] of [['DCSA', /\bdcsa\b/iu], ['eUCP', /\beucp\b/iu], ['MLETR', /\bmletr\b/iu], ['ICC DSI', /\bicc[ _-]?dsi\b/iu]]) if (re.test(fact.value)) declared.add(id);
  for (const standard of ['mletr', 'eucp', 'dcsa', 'icc_dsi']) {
    if (caseData.metadata?.[standard] === true || (Array.isArray(caseData.metadata?.standards) && caseData.metadata.standards.some((item) => typeof item === 'string' && item.toLowerCase() === standard))) {
      declared.add(standard === 'eucp' ? 'eUCP' : standard === 'icc_dsi' ? 'ICC DSI' : standard.toUpperCase());
    }
  }
  const warehouse = Boolean(caseData.warehouse_receipt) || caseData.bill_of_lading?.bl_type === 'electronic_warehouse_receipt';
  add('standards', platformFacts[0]?.field ?? 'metadata.standards', declared.size || warehouse ? 'CLEAR' : 'REVIEW',
    declared.size ? 'STANDARD_DECLARED' : warehouse ? 'STANDARD_NOT_APPLICABLE' : 'STANDARD_UNDECLARED',
    declared.size ? 'Recognized standard names were declared; no platform conformance or legal recognition was verified.' : warehouse ? 'Warehouse receipt; maritime eBL standards were not inferred.' : 'No recognized digital-trade standard was declared; verify the platform manually.',
    platformFacts[0]?.value, { declared_standards: [...declared] });
  add('fair_access', 'caseEntry.company_size', 'CLEAR', 'FAIR_ACCESS', 'Company size is not a refusal criterion.');
  return complianceReport(checks, data);
}
