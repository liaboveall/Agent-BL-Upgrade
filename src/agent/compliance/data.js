import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';

const short = z.string().min(1).max(600);
const fictional = z.object({ id: short, name: short, aliases: z.array(short).default([]), fictional: z.literal(true) }).strict();
const screeningSchema = z.object({
  version: short, as_of: z.iso.date(), mode: z.literal('demo'), description: short,
  sources: z.array(z.object({ title: short, url: z.url() }).strict()).min(1),
  entities: z.array(fictional).min(1),
  jurisdictions: z.array(z.object({ id: short, country: z.string().regex(/^[A-Z]{2}$/u), name: short, status: z.literal('BLOCK') }).strict()),
  vessels: z.array(fictional.extend({ imo: z.string().regex(/^\d{7}$/u) })).min(1),
  hs_rules: z.array(z.object({ id: short, prefix: z.string().regex(/^\d{2,6}$/u), category: z.enum(['military', 'dual_use']), status: z.enum(['BLOCK', 'REVIEW']) }).strict())
}).strict();
const portsSchema = z.object({ version: short, as_of: z.iso.date(), source: short,
  ports: z.array(z.object({ id: z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}$/u), country: z.string().regex(/^[A-Z]{2}$/u), aliases: z.array(short).min(1) }).strict()).min(1)
}).strict();

function immutable(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}

export function validateComplianceData(screening, ports) {
  const list = screeningSchema.parse(screening), locations = portsSchema.parse(ports);
  const entries = [...list.entities, ...list.jurisdictions, ...list.vessels, ...list.hs_rules];
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new TypeError('Duplicate compliance entry ID');
  if (new Set(locations.ports.map((entry) => entry.id)).size !== locations.ports.length) throw new TypeError('Duplicate port ID');
  if (locations.ports.some((entry) => !entry.id.startsWith(entry.country))) throw new TypeError('Port code/country mismatch');
  for (const entry of list.vessels) if (!validImo(entry.imo)) throw new TypeError('Invalid demo vessel IMO checksum');
  const hash = crypto.createHash('sha256').update(JSON.stringify({ list, locations })).digest('hex');
  return immutable({ list, locations, hash });
}

export function validImo(value) {
  if (!/^\d{7}$/u.test(String(value))) return false;
  const chars = [...String(value)].map(Number);
  return chars.slice(0, 6).reduce((sum, digit, i) => sum + digit * (7 - i), 0) % 10 === chars[6];
}

export const COMPLIANCE_DATA = validateComplianceData(
  JSON.parse(fs.readFileSync(new URL('../../../data/compliance/screening-list.json', import.meta.url), 'utf8')),
  JSON.parse(fs.readFileSync(new URL('../../../data/compliance/ports.json', import.meta.url), 'utf8'))
);
