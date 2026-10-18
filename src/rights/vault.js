import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from '../app/http.js';

export function rightsKey(env = process.env) {
  const raw = env.AGENTBL_RIGHTS_KEY;
  if (!raw) return null;
  if (!/^[a-fA-F0-9]{64}$/u.test(raw)) throw new HttpError(503, 'rights_key_invalid', 'Rights vault key must be a separately managed 32-byte key');
  return Buffer.from(raw, 'hex');
}
export function seal(key, value, aad) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { algorithm: 'AES-256-GCM', iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
}
export function unseal(key, envelope, aad) {
  try {
    if (envelope.algorithm !== 'AES-256-GCM') throw new Error('Invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    throw new HttpError(503, 'rights_vault_unavailable', 'Rights vault authentication failed; restore the authorized key and intact data');
  }
}
