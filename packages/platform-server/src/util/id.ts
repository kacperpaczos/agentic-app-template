import { randomUUID, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
export const nowIso = (): string => new Date().toISOString();
export const sha256 = (b: Uint8Array | string): string =>
  createHash('sha256').update(b).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
