// AI-17 — deterministic-first trade document parser.
//
// The parser accepts text/Markdown directly and supports PDF/image OCR through
// an injected `textExtractor`. An optional `aiExtractor` may fill missing
// fields, but deterministic extraction remains the fallback and every field
// carries source-line provenance plus a confidence score.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DocumentParseError } from './ingest/extractionError.js';
import { extractPdfText } from './ingest/pdfText.js';
import { FIELD_SCHEMAS, supportedField, validateModelExtraction } from './ingest/modelExtraction.js';
import { screenDocumentText } from './ingest/injectionScreen.js';

export { DocumentParseError };
export const DOCUMENT_TYPES = ['EBL', 'COMMERCIAL_INVOICE', 'INSURANCE_POLICY', 'WAREHOUSE_RECEIPT'];

function hashText(text) {
  return `0x${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function stripMarkdown(value = '') {
  return String(value)
    .replace(/\*\*/gu, '')
    .replace(/`/gu, '')
    .replace(/^#+\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function labelKey(value = '') {
  return stripMarkdown(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}0-9]+/gu, ' ').trim();
}

function lineNumber(text, offset) {
  return text.slice(0, Math.max(0, offset)).split(/\r?\n/u).length;
}

function parseTableEntries(text) {
  const entries = [];
  const lines = text.split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (!line.trim().startsWith('|')) return;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2 || cells.every((cell) => /^:?-+:?$/u.test(cell))) return;
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const key = labelKey(cells[i]);
      const value = stripMarkdown(cells[i + 1]);
      if (!key || !value || key === 'field' || key === 'value') continue;
      entries.push({ key, value, line: index + 1, method: 'markdown-table', confidence: 0.98 });
    }
  });
  return entries;
}

function parseInlineEntries(text) {
  const entries = [];
  const pattern = /\*\*([^*\n]+?)(?::)?\*\*\s*:?[ \t]*([^\n|]+)/gu;
  for (const match of text.matchAll(pattern)) {
    const key = labelKey(match[1]);
    const value = stripMarkdown(match[2]);
    if (!key || !value || value === '---') continue;
    entries.push({ key, value, line: lineNumber(text, match.index ?? 0), method: 'inline-label', confidence: 0.94 });
  }
  // Plain PDF labels (no Markdown formatting), including full-width Chinese colons.
  const plain = /^([^\n:：|]{1,70})[:：][ \t]*([^\n|]+)/gmu;
  for (const match of text.matchAll(plain)) {
    entries.push({ key: labelKey(match[1]), value: stripMarkdown(match[2]), line: lineNumber(text, match.index), method: 'text-label', confidence: 0.94 });
  }
  return entries;
}

function entryFor(entries, labels) {
  const keys = labels.map(labelKey);
  return entries.find((entry) => keys.includes(entry.key))
    ?? entries.find((entry) => entry.key.length > 3 && keys.some((key) => entry.key.startsWith(`${key} `)));
}

function sectionValue(text, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const re = new RegExp(`\\*\\*${escaped}\\*\\*\\s*\\r?\\n([^\\n]+)`, 'iu');
    const match = re.exec(text);
    if (match) {
      return {
        value: stripMarkdown(match[1]),
        line: lineNumber(text, match.index),
        method: 'section-label',
        confidence: 0.93
      };
    }
  }
  return null;
}

function regexValue(text, regex, confidence = 0.88) {
  const match = regex.exec(text);
  if (!match) return null;
  return {
    value: stripMarkdown(match[1]),
    line: lineNumber(text, match.index),
    method: 'regex',
    confidence
  };
}

function numeric(value) {
  if (value === undefined || value === null) return null;
  const match = String(value).replace(/,/gu, '').match(/-?\d+(?:\.\d+)?/u);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function money(value) {
  return numeric(value);
}

function isoDate(value) {
  if (!value) return null;
  const match = String(value).match(/\b(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)\b/u);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  // A calendar date has no timezone. Date.parse('15 May 2026') uses the host's local midnight,
  // which becomes May 14 in UTC on Singapore hosts. Parse written dates at explicit UTC midnight.
  const written = String(value).match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(20\d{2})\b/iu);
  if (written) return new Date(Date.parse(`${written[1]} ${written[2]} ${written[3]} 00:00:00 GMT`)).toISOString().slice(0, 10);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function hsCode(value) {
  const match = String(value ?? '').match(/\b(\d{4})[.]?(\d{2})\b/u);
  return match ? `${match[1]}${match[2]}` : null;
}

function vesselVoyage(value) {
  if (!value) return { vessel: null, voyage_no: null };
  const [vessel, ...rest] = String(value).split('/');
  return { vessel: stripMarkdown(vessel), voyage_no: stripMarkdown(rest.join('/')) || null };
}

const BARREL_UNIT = /\b(?:bbl|bbls|barrels?)\b/iu;
const BARREL_QUANTITY = /\d[\d,.]*\s*(?:net\s+(?:US\s+)?)?(?:bbl|bbls|barrels?)\b/iu;

/** Tonnes for a cargo quoted in barrels: stated on the document ("78,221 MT"), never converted by guess. */
function tonnesStatedInText(text, entries) {
  const stated = entryFor(entries, ['Metric Tonnes (in air)', 'Metric Tonnes', 'Net Weight (MT)']);
  if (stated && numeric(stated.value) !== null) return { value: numeric(stated.value), line: stated.line, method: stated.method, confidence: 0.9 };
  const inline = regexValue(text, /\(\s*([\d,.]+)\s*MT\s*\)/iu, 0.88);
  return inline && numeric(inline.value) !== null ? { ...inline, value: numeric(inline.value) } : null;
}

function goodsRow(text) {
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(stripMarkdown);
    const joined = cells.join(' ');
    if (!/\b\d{4}[.]?\d{2}\b/u.test(joined) || !(/\bMT\b|\btonnes?\b|吨/iu.test(joined) || BARREL_UNIT.test(joined))) continue;
    const description = cells.find((cell) => /copper|soy|oil|ore|rubber|aluminium|aluminum|goods|铝|铜|大豆|原油|橡胶/iu.test(cell))
      ?? cells.find((cell) => cell.length > 20)
      ?? null;
    const quantityCell = cells.find((cell) => /\d[\d,.]*\s*(?:MT\b|tonnes?\b|吨)/iu.test(cell));
    const barrelCell = cells.find((cell) => BARREL_QUANTITY.test(cell));
    const amountCell = [...cells].reverse().find((cell) => /\d[\d,.]*/u.test(cell) && !/MT\b/iu.test(cell) && !BARREL_UNIT.test(cell));
    return {
      description,
      hs_code: hsCode(joined),
      quantity_mt: numeric(quantityCell),
      quantity_bbl: barrelCell ? numeric(barrelCell) : null,
      amount_usd: money(amountCell),
      cells,
      line: index + 1,
      method: 'goods-table',
      confidence: 0.96
    };
  }
  return null;
}

function fieldCollector() {
  const fields = {};
  const provenance = {};
  const add = (name, source, transform = (value) => value) => {
    if (!source || source.value === undefined || source.value === null || source.value === '') return;
    const value = transform(source.value);
    if (value === null || value === undefined || value === '') return;
    fields[name] = value;
    provenance[name] = {
      line: source.line ?? null,
      method: source.method ?? 'unknown',
      confidence: source.confidence ?? 0.8,
      raw: String(source.value).slice(0, 240)
    };
  };
  return { fields, provenance, add };
}

function detectDocumentType(text, filename = '') {
  const haystack = `${filename}\n${text.slice(0, 3000)}`.toLowerCase();
  if (/electronic warehouse receipt|warehouse.receipt|电子仓单|仓单类型/u.test(haystack)) return 'WAREHOUSE_RECEIPT';
  if (/commercial invoice|invoice no|total invoice/u.test(haystack)) return 'COMMERCIAL_INVOICE';
  if (/insurance policy|policy no|insured amount|marine cargo/u.test(haystack)) return 'INSURANCE_POLICY';
  if (/bill of lading|electronic bill|\bebl\b|b\/l no/u.test(haystack)) return 'EBL';
  throw new DocumentParseError('Unable to determine document type', 'UNKNOWN_DOCUMENT_TYPE', { filename });
}

function parseEbl(text, entries) {
  const c = fieldCollector();
  const get = (...labels) => entryFor(entries, labels);
  c.add('bl_no', get('B/L No.', 'Bill of Lading No.', 'BL No.'));
  c.add('bl_id', get('eBL Token / Title Ref', 'eBL Title Ref'));
  c.add('bl_type', get('B/L Type'));
  c.add('ebl_platform', get('eBL Platform'));
  c.add('carrier', get('Carrier'));
  c.add('shipper', sectionValue(text, ['Shipper / Exporter', 'Shipper']));
  c.add('consignee', sectionValue(text, ['Consignee']));
  c.add('notify_party', sectionValue(text, ['Notify Party']));
  c.add('shipper', get('Shipper', 'Shipper / Exporter'));
  c.add('consignee', get('Consignee'));
  c.add('notify_party', get('Notify Party'));
  const vv = get('Vessel / Voyage');
  if (vv) {
    const parsed = vesselVoyage(vv.value);
    c.add('vessel', { ...vv, value: parsed.vessel });
    c.add('voyage_no', { ...vv, value: parsed.voyage_no });
  }
  if (!c.fields.vessel) c.add('vessel', get('Vessel'));
  if (!c.fields.voyage_no) c.add('voyage_no', get('Voyage No.', 'Voyage Number'));
  c.add('port_of_loading', get('Port of Loading', 'Place / Terminal of Loading', 'Terminal of Loading'));
  c.add('port_of_discharge', get('Port of Discharge'));
  c.add('shipped_on_board', get('Shipped on Board', 'Loaded on Board (B/L date)', 'Loaded on Board'), isoDate);
  c.add('eta', get('Estimated Time of Arrival (ETA)', 'ETA'), isoDate);
  c.add('issue_date', get('Place & Date of Issue'), isoDate);
  c.add('document_hash', get('Document Hash (SHA-256)', 'Document Hash'));
  c.add('cargo', get('Cargo', 'Commodity', 'Description of Goods'));
  c.add('quantity_mt', get('Quantity (MT)', 'Net Weight (MT)'), numeric);
  c.add('hs_code', get('HS Code'), hsCode);
  const goods = goodsRow(text);
  if (goods) {
    const source = (value) => ({ ...goods, value });
    c.add('cargo', source(goods.description));
    c.add('hs_code', source(goods.hs_code));
    c.add('quantity_mt', source(goods.quantity_mt ?? tonnesStatedInText(text, entries)?.value), Number);
    c.add('quantity_bbl', source(goods.quantity_bbl), Number);
  }
  c.add('declared_value_usd', regexValue(text, /Declared Cargo Value[^\n]*?USD\s*([\d,.]+)/iu, 0.97), money);
  c.add('declared_value_usd', get('Declared Cargo Value (USD)', 'Declared Value (USD)'), money);
  c.add('incoterms', get('Incoterms'));
  c.add('incoterms', regexValue(text, /Declared Cargo Value[^\n]*?\(((?:CIF|CFR|FOB|DAP|DDP)[^)]+)\)/iu, 0.75));
  if (!c.fields.bl_id && c.fields.bl_no) c.add('bl_id', { value: c.fields.bl_no, line: c.provenance.bl_no.line, method: 'derived-from-bl-no', confidence: 0.8 });
  return c;
}

function parseInvoice(text, entries) {
  const c = fieldCollector();
  const get = (...labels) => entryFor(entries, labels);
  c.add('invoice_no', get('Invoice No.', '发票号码', '发票编号'));
  c.add('invoice_date', get('Invoice Date', '发票日期'), isoDate);
  c.add('sales_contract', get('Sales Contract', '销售合同'));
  c.add('incoterms', get('Incoterms 2020', 'Incoterms'));
  c.add('payment_terms', get('Payment Terms'));
  c.add('bl_no', get('B/L No.'));
  c.add('receipt_no', get('Warehouse Receipt No.', '仓单编号'));
  const vv = get('Vessel / Voyage');
  if (vv) {
    const parsed = vesselVoyage(vv.value);
    c.add('vessel', { ...vv, value: parsed.vessel });
    c.add('voyage_no', { ...vv, value: parsed.voyage_no });
  }
  c.add('port_of_loading', get('Port of Loading', 'Place / Terminal of Loading', 'Terminal of Loading'));
  c.add('port_of_discharge', get('Port of Discharge'));
  c.add('seller', regexValue(text, /\*\*Seller \(Beneficiary\):\*\*\s*([^\n]+)/iu, 0.95));
  c.add('buyer', regexValue(text, /\*\*Buyer \(Applicant\):\*\*\s*([^\n]+)/iu, 0.95));
  c.add('seller', get('Seller', 'Seller (Beneficiary)', '卖方'));
  c.add('buyer', get('Buyer', 'Buyer (Applicant)', '买方'));
  c.add('quantity_mt', get('Quantity (MT)', '数量（吨）'), numeric);
  c.add('unit_price_usd_per_mt', get('Unit Price (USD/MT)'), money);
  const currency = /\bCNY\b|人民币|¥/u.test(text) ? 'CNY' : /\bUSD\b|US\$/u.test(text) ? 'USD' : null;
  const goods = goodsRow(text);
  if (goods) {
    const source = (value) => ({ ...goods, value });
    c.add('cargo', source(goods.description));
    c.add('hs_code', source(goods.hs_code));
    c.add('quantity_mt', source(goods.quantity_mt ?? tonnesStatedInText(text, entries)?.value), Number);
    c.add('quantity_bbl', source(goods.quantity_bbl), Number);
    const numericCells = goods.cells.map((cell) => numeric(cell)).filter((value) => value !== null);
    if (numericCells.length >= 2) {
      // The unit price is quoted in the cargo's own unit: per barrel for crude, per tonne otherwise.
      const priceField = currency === 'CNY' ? 'unit_price_cny_per_mt' : goods.quantity_bbl && goods.quantity_mt === null ? 'unit_price_usd_per_bbl' : 'unit_price_usd_per_mt';
      if (currency) {
        c.add(priceField, source(numericCells.at(-2)), Number);
        c.add(currency === 'CNY' ? 'total_amount_cny' : 'total_amount_usd', source(numericCells.at(-1)), Number);
      }
    }
  }
  c.add('total_amount_usd', regexValue(text, /Total Invoice Value:\s*USD\s*([\d,.]+)/iu, 0.99), money);
  if (!c.fields.total_amount_usd) c.add('total_amount_usd', get('Total Amount (USD)', 'Total Invoice Value (USD)'), money);
  c.add('total_amount_cny', regexValue(text, /发票总金额[^\n]*?CNY\s*¥?([\d,.]+)/u, 0.99), money);
  c.add('currency', regexValue(text, /(\bCNY\b|人民币|¥|\bUSD\b|US\$)/u, 0.9), () => currency);
  c.add('is_provisional', regexValue(text, /\b(PROVISIONAL INVOICE)\b/iu, 0.98), () => true);
  return c;
}

function parseInsurance(text, entries) {
  const c = fieldCollector();
  const get = (...labels) => entryFor(entries, labels);
  c.add('policy_no', get('Policy No.'));
  c.add('policy_type', get('Policy Type'));
  c.add('provider', get('Insurer'));
  c.add('insured_party', sectionValue(text, ['Insured']));
  c.add('origin', get('From'));
  c.add('destination', get('To'));
  const vv = get('Vessel');
  if (vv) {
    const parsed = vesselVoyage(vv.value);
    c.add('vessel', { ...vv, value: parsed.vessel });
    c.add('voyage_no', { ...vv, value: parsed.voyage_no });
  }
  c.add('commodity', get('Commodity'));
  c.add('quantity_mt', get('Quantity'), numeric);
  c.add('cif_value_usd', get('CIF Value'), money);
  c.add('coverage_ratio', get('Coverage Ratio'), (value) => {
    const n = numeric(value);
    return n === null ? null : (n > 2 ? n / 100 : n);
  });
  c.add('insured_value_usd', get('Insured Amount', 'Sum Insured'), money);
  c.add('expires_at', get('Expiry'), isoDate);
  c.add('deductible_usd', get('Deductible'), money);
  c.add('policy_hash', get('Policy Hash'));
  return c;
}

function parseWarehouse(text, entries) {
  const c = fieldCollector();
  const get = (...labels) => entryFor(entries, labels);
  c.add('receipt_no', get('仓单编号', 'Warehouse Receipt No.', 'Receipt No.'));
  c.add('title_ref', get('Token / Title Ref', 'Title Ref'));
  c.add('ebl_platform', get('签发平台', 'Issuing Platform'));
  c.add('issue_date', get('签发日期', 'Issue Date'), isoDate);
  c.add('shipper', sectionValue(text, ['出让人（Shipper / 仓单签发时货主）', 'Shipper']));
  c.add('consignee', sectionValue(text, ['受让人（Consignee / 仓单受让方）', 'Consignee']));
  c.add('warehouse', get('交割仓库', 'Warehouse'));
  c.add('warehouse_address', get('仓库地址', 'Warehouse Address'));
  c.add('warehouse_operator', get('签发人', 'Warehouse Operator'));
  c.add('storage_date', get('入库日期', 'Storage Date'), isoDate);
  c.add('pickup_deadline', get('提货有效期', 'Pickup Deadline'), isoDate);
  c.add('incoterms', get('交货方式', 'Incoterms'));
  c.add('document_hash', get('Document Hash (SHA-256)', 'Document Hash'));
  const goods = goodsRow(text);
  if (goods) {
    c.add('cargo', { ...goods, value: goods.description });
    c.add('hs_code', { ...goods, value: goods.hs_code });
    c.add('quantity_mt', { ...goods, value: goods.quantity_mt }, Number);
  }
  c.add('quantity_mt', get('Quantity (MT)'), numeric);
  c.add('declared_value_cny', regexValue(text, /申报货值[^\n]*?CNY\s*¥?([\d,.]+)/u, 0.97), money);
  if (c.fields.declared_value_cny) c.add('currency', regexValue(text, /(\bCNY\b|人民币|¥)/u, 0.9), () => 'CNY');
  return c;
}

function toCaseFragment(type, fields, textHash) {
  if (type === 'EBL') {
    return {
      bill_of_lading: {
        bl_id: fields.bl_id ?? fields.bl_no,
        bl_no: fields.bl_no,
        bl_type: fields.bl_type,
        ebl_platform: fields.ebl_platform,
        shipper: fields.shipper,
        consignee: fields.consignee,
        notify_party: fields.notify_party,
        carrier: fields.carrier,
        vessel: fields.vessel,
        voyage_no: fields.voyage_no,
        port_of_loading: fields.port_of_loading,
        port_of_discharge: fields.port_of_discharge,
        cargo: fields.cargo,
        quantity_mt: fields.quantity_mt,
        quantity_bbl: fields.quantity_bbl,
        declared_value_usd: fields.declared_value_usd,
        incoterms: fields.incoterms,
        issue_date: fields.issue_date ?? fields.shipped_on_board,
        shipped_on_board: fields.shipped_on_board,
        eta: fields.eta,
        document_hash: fields.document_hash ?? textHash
      },
      cargo: { hs_code: fields.hs_code, quantity_mt: fields.quantity_mt, commodity: fields.cargo }
    };
  }
  if (type === 'COMMERCIAL_INVOICE') {
    return {
      commercial_invoice: {
        invoice_no: fields.invoice_no,
        invoice_date: fields.invoice_date,
        sales_contract: fields.sales_contract,
        incoterms: fields.incoterms,
        payment_terms: fields.payment_terms,
        bl_no: fields.bl_no,
        seller: fields.seller,
        buyer: fields.buyer,
        unit_price_usd_per_mt: fields.unit_price_usd_per_mt,
        unit_price_usd_per_bbl: fields.unit_price_usd_per_bbl,
        quantity_bbl: fields.quantity_bbl,
        quantity_mt: fields.quantity_mt,
        total_amount_usd: fields.total_amount_usd,
        currency: fields.currency,
        is_provisional: fields.is_provisional,
        hs_code: fields.hs_code,
        receipt_no: fields.receipt_no,
        total_amount_cny: fields.total_amount_cny,
        unit_price_cny_per_mt: fields.unit_price_cny_per_mt
      },
      cargo: { hs_code: fields.hs_code, quantity_mt: fields.quantity_mt, commodity: fields.cargo }
    };
  }
  if (type === 'WAREHOUSE_RECEIPT') return { warehouse_receipt: { ...fields, document_hash: fields.document_hash ?? textHash } };
  return {
    insurance: {
      policy_no: fields.policy_no,
      provider: fields.provider,
      policy_type: fields.policy_type,
      insured_value_usd: fields.insured_value_usd,
      coverage_ratio: fields.coverage_ratio,
      expires_at: fields.expires_at,
      policy_hash: fields.policy_hash ?? textHash
    }
  };
}

function removeUndefined(value) {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null && item !== '')
    .map(([key, item]) => [key, removeUndefined(item)]));
}

function mergeDeep(base, next) {
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = mergeDeep(out[key], value);
    else if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

async function resolveBinary(buffer, filename, mimeType, options) {
  if (/text|markdown|json/iu.test(mimeType)) return { text: buffer.toString('utf8'), filename, mimeType, extractor: 'buffer-text' };
  if (options.textExtractor) return { text: String(await options.textExtractor({ buffer, filename, mimeType })), filename, mimeType, extractor: 'injected-ocr' };
  if (mimeType === 'application/pdf' || path.extname(filename).toLowerCase() === '.pdf') {
    return { ...await extractPdfText(buffer, options.pdfLimits), filename, mimeType: 'application/pdf' };
  }
  if (/^image\/(?:png|jpeg)$/u.test(mimeType)) {
    if (!options.visionEnabled || !options.visionExtractor) throw new DocumentParseError('Image extraction is disabled or no vision provider is configured; supply corrected text.', 'OCR_REQUIRED');
    if (screenDocumentText(filename).suspicious) throw new DocumentParseError('The filename contains suspected instructions.', 'PROMPT_INJECTION_SUSPECTED');
    const result = await options.visionExtractor({ buffer, filename, mimeType });
    const validated = validateModelExtraction({ document_type: result.document_type, text: result.text, fields: result.fields });
    if (screenDocumentText(`${validated.text}\n${JSON.stringify(validated.fields)}`).suspicious) {
      throw new DocumentParseError('The image extraction contains suspected instructions.', 'PROMPT_INJECTION_SUSPECTED');
    }
    return { text: validated.text, filename, mimeType, extractor: 'llm-vision',
      documentType: validated.document_type, modelFields: validated.fields, forceReview: true,
      provider: result.provider ?? 'injected', model: result.model ?? null };
  }
  throw new DocumentParseError('This binary document requires OCR or corrected text.', 'OCR_REQUIRED');
}

export async function extractDocumentInput(input, options = {}) {
  const descriptor = typeof input === 'object' && !Buffer.isBuffer(input) ? input : {};
  const filename = descriptor.filename ?? descriptor.name ?? descriptor.path ?? (typeof input === 'string' ? input : 'document');
  const mimeType = descriptor.mimeType ?? descriptor.mime_type ?? descriptor.contentType ?? '';
  if (descriptor.text !== undefined && descriptor.text !== null) return { text: String(descriptor.text), filename, mimeType, extractor: 'provided-text' };

  if (descriptor.buffer || Buffer.isBuffer(input)) {
    const buffer = Buffer.from(descriptor.buffer ?? input);
    return resolveBinary(buffer, filename, mimeType, options);
  }

  if (descriptor.path || (typeof input === 'string' && !input.includes('\n'))) {
    const filePath = descriptor.path ?? input;
    try {
      const buffer = await fs.readFile(filePath);
      const extension = path.extname(filePath).toLowerCase();
      if (['.md', '.txt', '.json', '.csv'].includes(extension)) {
        return { text: buffer.toString('utf8'), filename: filePath, mimeType, extractor: 'file-text' };
      }
      return resolveBinary(buffer, filePath, mimeType || ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[extension] ?? ''), options);
    } catch (error) {
      if (error instanceof DocumentParseError) throw error;
      if (error?.code !== 'ENOENT' || descriptor.path) throw error;
    }
  }

  return { text: String(input), filename, mimeType, extractor: 'inline-text' };
}

/** Parse one eBL, invoice, or insurance document. */
export async function parseDocument(input, options = {}) {
  const resolved = options.extracted ?? await extractDocumentInput(input, options);
  // eslint-disable-next-line no-control-regex -- NUL bytes left by binary extraction are noise
  const text = resolved.text.replace(/\u0000/gu, '').trim();
  if (text.length < 20) throw new DocumentParseError('Document text is empty or too short', 'EMPTY_DOCUMENT', { filename: resolved.filename });
  const type = options.documentType ?? resolved.documentType ?? detectDocumentType(text, resolved.filename);
  if (!DOCUMENT_TYPES.includes(type)) throw new DocumentParseError(`Unsupported document type: ${type}`, 'UNKNOWN_DOCUMENT_TYPE');

  const entries = [...parseTableEntries(text), ...parseInlineEntries(text)];
  const parsed = type === 'EBL' ? parseEbl(text, entries)
    : type === 'COMMERCIAL_INVOICE' ? parseInvoice(text, entries)
      : type === 'INSURANCE_POLICY' ? parseInsurance(text, entries) : parseWarehouse(text, entries);
  const warnings = [];
  const findings = [];
  const requiredByType = {
    EBL: ['bl_id', 'carrier', 'shipper', 'consignee', 'vessel', 'port_of_loading', 'port_of_discharge', 'cargo', 'quantity_mt', 'document_hash'],
    COMMERCIAL_INVOICE: ['invoice_no', 'invoice_date', 'incoterms', 'quantity_mt', 'currency', ...(parsed.fields.currency === 'CNY' ? ['total_amount_cny'] : ['total_amount_usd'])],
    INSURANCE_POLICY: ['policy_no', 'provider', 'insured_value_usd'],
    WAREHOUSE_RECEIPT: ['receipt_no', 'title_ref', 'warehouse', 'shipper', 'consignee', 'quantity_mt', 'hs_code', 'document_hash']
  };
  let usedModelFields = false;
  const mergeModelFields = (fields, method) => {
    for (const field of fields) {
      const { name, value, evidence } = field;
      if (!FIELD_SCHEMAS[name]?.safeParse(value).success) continue;
      if (!supportedField(field, text)) {
        findings.push({ kind: 'MODEL_FIELD_UNSUPPORTED', severity: 'high', detail: `No matching written evidence for ${name}; the proposed value was ignored.` });
        continue;
      }
      if (parsed.fields[name] !== undefined) {
        if (parsed.fields[name] !== value) findings.push({ kind: 'EXTRACTION_CONFLICT', severity: 'high', detail: `The model disagreed on ${name}; the deterministic value was retained.` });
        continue;
      }
      parsed.fields[name] = value;
      parsed.provenance[name] = { line: lineNumber(text, text.indexOf(evidence)), method, confidence: method === 'llm-vision' ? 0.75 : 0.72, raw: evidence.slice(0, 240) };
      usedModelFields = true;
    }
  };
  if (resolved.modelFields) mergeModelFields(resolved.modelFields, 'llm-vision');
  const suspicious = screenDocumentText(`${resolved.filename}\n${text}`).suspicious;
  const missingBeforeAI = requiredByType[type].some((name) => parsed.fields[name] === undefined);

  if (options.aiExtractor && !suspicious && (missingBeforeAI || options.completeAllFields)) {
    try {
      const ai = await options.aiExtractor({ text, documentType: type, fields: { ...parsed.fields } });
      if (!Array.isArray(ai?.fields)) throw new DocumentParseError('Missing typed field evidence.', 'MODEL_OUTPUT_INVALID');
      const checked = validateModelExtraction({ document_type: ai.document_type ?? type, text: ai.text ?? '', fields: ai.fields });
      if (checked.document_type !== type) throw new DocumentParseError('The model changed the document type.', 'MODEL_OUTPUT_INVALID');
      if (screenDocumentText(JSON.stringify(checked)).suspicious) throw new DocumentParseError('Suspected instructions in model output.', 'PROMPT_INJECTION_SUSPECTED');
      mergeModelFields(checked.fields, 'ai-extractor');
    } catch (error) {
      warnings.push('AI extractor failed; deterministic fallback used.');
      findings.push({ kind: error.code === 'PROMPT_INJECTION_SUSPECTED' ? error.code : 'MODEL_EXTRACTION_FAILED', severity: 'high', detail: 'Model field completion failed or returned unsafe output; human review is required.' });
    }
  }
  if (suspicious) findings.push({ kind: 'PROMPT_INJECTION_SUSPECTED', severity: 'high', detail: 'Suspected document instructions; model completion was blocked.' });
  if (resolved.blankPages?.length) findings.push({ kind: 'OCR_REQUIRED', severity: 'high', detail: `PDF page(s) ${resolved.blankPages.join(', ')} have no usable text layer.` });
  if (resolved.extractor === 'llm-vision') {
    for (const item of Object.values(parsed.provenance)) {
      item.method = 'llm-vision'; item.confidence = Math.min(0.75, item.confidence);
    }
  }
  const leadingLines = resolved.text.slice(0, resolved.text.indexOf(resolved.text.trimStart())).split('\n').length - 1;
  for (const item of Object.values(parsed.provenance)) {
    if (resolved.linePages && item.line) {
      const globalLine = item.line + leadingLines;
      item.page = resolved.linePages[globalLine - 1];
      item.line = globalLine - resolved.linePages.indexOf(item.page);
    }
  }
  const required = requiredByType[type];
  const missing = required.filter((field) => parsed.fields[field] === undefined || parsed.fields[field] === null);
  if (missing.length > 0) warnings.push(`Missing required fields: ${missing.join(', ')}`);
  const extractedRequired = required.length - missing.length;
  const requiredCoverage = extractedRequired / required.length;
  const provenanceScores = Object.values(parsed.provenance).map((item) => item.confidence);
  const averageConfidence = provenanceScores.length > 0
    ? provenanceScores.reduce((sum, score) => sum + score, 0) / provenanceScores.length
    : 0;
  const confidence = Math.min(resolved.extractor === 'llm-vision' ? 0.75 : 1, Math.round((requiredCoverage * 0.65 + averageConfidence * 0.35) * 1000) / 1000);
  const textHash = hashText(text);

  return {
    document_type: type,
    source: { filename: resolved.filename, mime_type: resolved.mimeType || null, extractor: resolved.extractor,
      ...(resolved.totalPages ? { total_pages: resolved.totalPages } : {}),
      ...(resolved.provider ? { provider: resolved.provider, model: resolved.model } : {}) },
    fields: parsed.fields,
    provenance: parsed.provenance,
    confidence,
    requires_human_review: confidence < (options.reviewThreshold ?? 0.82) || missing.length > 0 || Boolean(resolved.forceReview) || usedModelFields || findings.some((item) => item.severity === 'high'),
    missing_fields: missing,
    warnings,
    findings,
    text_hash: textHash,
    case_fragment: removeUndefined(toCaseFragment(type, parsed.fields, textHash))
  };
}

/** Parse a document bundle and merge it over an optional structured case. */
export async function parseDocuments(inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new DocumentParseError('documents must be a non-empty array', 'NO_DOCUMENTS');
  const documents = [];
  for (const input of inputs) documents.push(await parseDocument(input, options));
  return mergeParsedDocuments(documents, options);
}

export function mergeParsedDocuments(documents, options = {}) {
  let mergedCase = structuredClone(options.templateCase ?? {});
  for (const document of documents) mergedCase = mergeDeep(mergedCase, document.case_fragment);
  if (!mergedCase.case_id) {
    const seed = mergedCase.bill_of_lading?.bl_id ?? documents.map((document) => document.text_hash).join(':');
    mergedCase.case_id = `CASE-PARSED-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12).toUpperCase()}`;
  }
  mergedCase.document_parsing = documents.map(({ document_type, source, confidence, requires_human_review, text_hash }) => ({
    document_type, source, confidence, requires_human_review, text_hash
  }));

  return {
    case_id: mergedCase.case_id,
    documents,
    case_data: mergedCase,
    requires_human_review: documents.some((document) => document.requires_human_review),
    warnings: documents.flatMap((document) => document.warnings.map((warning) => `${document.document_type}: ${warning}`))
  };
}
