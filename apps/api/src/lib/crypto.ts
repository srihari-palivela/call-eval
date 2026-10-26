// Secrets stored from the console (provider API keys, webhook secrets) are encrypted at rest with
// AES-256-GCM under a key derived from APP_SECRET.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config';
import { log } from './log';

let warned = false;
function key() {
  let secret = config.appSecret;
  if (!secret) {
    if (!warned) { log.warn('APP_SECRET is not set; using a development key to encrypt stored secrets. Set APP_SECRET in production.'); warned = true; }
    secret = 'calleval-dev-secret-change-me';
  }
  return createHash('sha256').update(secret).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(blob: string): string {
  const [v, iv, tag, data] = blob.split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export const hint = (s: string | null | undefined) => (s ? `…${s.slice(-4)}` : null);
