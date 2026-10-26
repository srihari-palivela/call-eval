import { createHash, randomBytes } from 'node:crypto';

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const sha = (s: string, len = 16) => createHash('sha256').update(s).digest('hex').slice(0, len);
/** Stable internal call id: provider plus the provider's conversation id. */
export const callIdOf = (provider: string, externalId: string) => `${provider === 'elevenlabs' ? 'el' : provider === 'retell' ? 'rt' : provider === 'upload' ? 'up' : 'dm'}_${externalId}`;
