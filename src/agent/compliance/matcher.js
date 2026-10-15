import { normalizeForScreening } from '../ingest/injectionScreen.js';

const SUFFIXES = new Set(['ltd', 'limited', 'co', 'company', 'pte', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'plc']);

/** Normalize facts only; country words in a name never become jurisdiction evidence. */
export function normalizeEntity(value) {
  const tokens = normalizeForScreening(value).toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
  while (tokens.length && SUFFIXES.has(tokens.at(-1))) tokens.pop();
  return tokens.join(' ').replace(/(?:有限责任公司|有限公司)$/u, '').trim();
}

export function tokenJaccard(left, right) {
  const a = new Set(left.split(' ').filter(Boolean)), b = new Set(right.split(' ').filter(Boolean));
  const union = new Set([...a, ...b]);
  return union.size ? [...a].filter((token) => b.has(token)).length / union.size : 0;
}

export function jaroWinkler(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = [...left], b = [...right], radius = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const matchedA = Array(a.length).fill(false), matchedB = Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - radius); j < Math.min(b.length, i + radius + 1); j++) {
      if (matchedB[j] || a[i] !== b[j]) continue;
      matchedA[i] = matchedB[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  const sequenceA = a.filter((_, i) => matchedA[i]), sequenceB = b.filter((_, i) => matchedB[i]);
  const transpositions = sequenceA.filter((char, i) => char !== sequenceB[i]).length / 2;
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro > 0.7 ? jaro + prefix * 0.1 * (1 - jaro) : jaro;
}

/** A typo affects characters less than tokens; both scores contribute to the fixed thresholds. */
export function entitySimilarity(left, right) {
  const a = normalizeEntity(left), b = normalizeEntity(right);
  const jaccard = tokenJaccard(a, b), winkler = jaroWinkler(a, b);
  return { score: a && b ? 0.3 * jaccard + 0.7 * winkler : 0, token_jaccard: jaccard, jaro_winkler: winkler };
}

export function matchEntity(name, entries) {
  let best = null;
  // Invoice names may include a comma-separated country or address. Screen each written name
  // segment as well as the full value, so adding an address cannot hide a listed name.
  const candidates = [...new Set([String(name), ...String(name).split(/[,;\n]/u)])].filter((value) => value.trim());
  for (const entry of entries) for (const alias of [entry.name, ...(entry.aliases ?? [])]) {
    for (const candidate of candidates) {
      const match = { entry, alias, ...entitySimilarity(candidate, alias) };
      if (!best || match.score > best.score) best = match;
    }
  }
  return best;
}
