// Compliance checker engine (AI-18)
//
// DEMO RULES ONLY. Every check below is a keyword match on names and cargo text. Nothing is
// looked up in the OFAC SDN list, the UN list, the EU list or any export-control classification
// (docs/agent-implementation-plan.md WP2.3 replaces this with a versioned, fuzzy-matched demo
// list). The outputs say so, so a result is never mistaken for a real screening.
// Note: only flags risks, does NOT refuse service based on company size.

export const COMPLIANCE_DISCLAIMER = 'Keyword-based demo rules; not an OFAC/UN/EU list screening and not a legal determination.';

export function checkCompliance(caseData = {}) {
  const checks = [];
  const add = (id, label, status, detail, evidence) => {
    checks.push({ id, label, status, detail, evidence });
  };

  const entities = [];
  if (caseData.caseEntry) {
    if (caseData.caseEntry.buyer) entities.push({ role: 'buyer', name: caseData.caseEntry.buyer });
    if (caseData.caseEntry.seller) entities.push({ role: 'seller', name: caseData.caseEntry.seller });
  }
  if (caseData.bill_of_lading) {
    if (caseData.bill_of_lading.shipper) entities.push({ role: 'shipper', name: caseData.bill_of_lading.shipper });
    if (caseData.bill_of_lading.consignee) entities.push({ role: 'consignee', name: caseData.bill_of_lading.consignee });
  }

  // 1. Sanctions Check
  // Demo rule: if any entity contains "sanctioned" or a sanctioned country (e.g. Iran, DPRK), block.
  let hasSanction = false;
  let sanctionEvidence = '';
  for (const ent of entities) {
    const name = (ent.name || '').toLowerCase();
    if (name.includes('sanctioned') || name.includes('iran') || name.includes('dprk') || name.includes('north korea')) {
      hasSanction = true;
      sanctionEvidence = `${ent.role} (${ent.name}) matched a demo sanctions keyword.`;
      break;
    }
  }

  if (hasSanction) {
    add('sanctions', 'Sanctions Check (demo keyword rule)', 'block', 'Entity name matched a demo sanctions keyword.', sanctionEvidence);
  } else {
    add('sanctions', 'Sanctions Check (demo keyword rule)', 'ok', 'No entity name matched a demo sanctions keyword.', 'Keyword demo rule only; no OFAC/UN/EU list was consulted.');
  }

  // 2. Export Controls
  // Demo rule: if cargo is "Military" or "Dual-use", flag warning or block.
  const cargo = (caseData.caseEntry?.cargo || caseData.bill_of_lading?.cargo || '').toLowerCase();
  if (cargo.includes('military') || cargo.includes('weapon')) {
    add('export_controls', 'Export Controls Check', 'block', 'Military cargo requires strict licensing.', `Cargo identified as: ${cargo}`);
  } else if (cargo.includes('dual-use') || cargo.includes('semiconductor') || cargo.includes('chip')) {
    add('export_controls', 'Export Controls Check', 'warning', 'Dual-use goods, requires end-user verification.', `Cargo identified as: ${cargo}`);
  } else {
    add('export_controls', 'Export Controls Check', 'ok', 'Cargo text did not match a demo export-control keyword.', 'Keyword demo rule only; no export-control classification (ECCN/EAR) was performed.');
  }

  // 3. MLETR / eUCP / DCSA / ICC DSI Standards
  const metadata = caseData.metadata || {};
  let stdCount = 0;
  const supported = ['mletr', 'eucp', 'dcsa', 'icc_dsi'];
  const matched = [];
  for (const s of supported) {
    if (metadata[s] === true || (metadata.standards && metadata.standards.includes(s))) {
      stdCount++;
      matched.push(s.toUpperCase());
    }
  }

  if (stdCount >= 2) {
    add('standards', 'Digital Trade Standards (MLETR/eUCP/DCSA)', 'ok', 'Strong compliance with digital trade standards.', `Matched: ${matched.join(', ')}`);
  } else if (stdCount === 1) {
    add('standards', 'Digital Trade Standards (MLETR/eUCP/DCSA)', 'warning', 'Minimal standard compliance.', `Matched: ${matched.join(', ')}`);
  } else {
    add('standards', 'Digital Trade Standards (MLETR/eUCP/DCSA)', 'warning', 'No recognized digital trade standards.', 'eBL may lack interoperability or legal standing.');
  }

  // 4. Company Size Discrimination (Explicitly ignore/avoid blocking)
  // Ensure we don't block just because of small size
  const size = (caseData.caseEntry?.company_size || '').toLowerCase();
  if (size === 'sme' || size === 'small' || size === 'startup') {
    add('fair_access', 'Fair Access Check', 'ok', 'Service provided regardless of company size.', 'Company size is SME, service approved.');
  }

  const ok = checks.every(c => c.status !== 'block');
  const has_warning = checks.some(c => c.status === 'warning');
  const has_block = checks.some(c => c.status === 'block');
  const issues = checks.filter(c => c.status !== 'ok').map(c => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`);

  return { ok, has_warning, has_block, checks, issues, disclaimer: COMPLIANCE_DISCLAIMER };
}
