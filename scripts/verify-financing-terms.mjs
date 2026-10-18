import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDisclosure } from '../src/rights/disclosure.js';

// Offline public-document verification; no .env, RPC, wallet or private material.
export function verifyFinancingTerms(input) {
  const pack = Object.fromEntries(['document', 'policy_hash', 'disclosure_hash', 'terms', 'terms_hash'].map((key) => [key, input?.[key]]));
  if (!verifyDisclosure(pack)) throw new Error('Financing disclosure commitments or policy are invalid');
  const t = pack.terms;
  return { passed: true, verification_scope: 'offline_public_document_and_eip712_only', business_enabled: false,
    terms_hash: pack.terms_hash, disclosure_hash: pack.disclosure_hash,
    chain_id: pack.document.instance.chain_id, controller: pack.document.instance.controller,
    gross_principal_atomic: String(BigInt(t.supply) * BigInt(t.issuePrice)), gross_target_atomic: String(BigInt(t.supply) * BigInt(t.target)),
    platform_fee_atomic: '0', chain_state_verified: false, external_rights_verified: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: npm run terms:verify -- <downloaded-terms.json>');
  console.log(JSON.stringify(verifyFinancingTerms(JSON.parse(await fs.readFile(process.argv[2], 'utf8'))), null, 2));
}
