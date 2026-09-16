import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppError } from '@platform/contracts';
import type { Db } from '../db/client.ts';
import { nowIso, randomToken, safeEqual } from '../util/id.ts';

export const SESSION_COOKIE = 'app_session';

/**
 * Local application authentication.
 *
 * Deliberately independent of the Claude subscription token: the OAuth
 * credential in `~/.claude` authenticates the *model*, never a user of this app.
 * The app issues its own HMAC-signed cookie; ownership on every request comes
 * from that cookie and from nothing else (not from a body field, not from a
 * model-supplied id).
 */
export class SessionAuth {
  readonly #secret: string;

  private constructor(secret: string) {
    this.#secret = secret;
  }

  /** Loads, or on first run generates, a server-side signing secret. */
  static load(dataDir: string): SessionAuth {
    const file = resolve(dataDir, 'session.secret');
    if (existsSync(file)) return new SessionAuth(readFileSync(file, 'utf8').trim());
    const secret = randomToken(48);
    writeFileSync(file, secret, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on exotic filesystems */
    }
    return new SessionAuth(secret);
  }

  sign(userId: string): string {
    const issued = Date.now().toString(36);
    const payload = `${userId}.${issued}`;
    const mac = createHmac('sha256', this.#secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  verify(token: string | undefined): string | null {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [userId, issued, mac] = parts as [string, string, string];
    const expected = createHmac('sha256', this.#secret)
      .update(`${userId}.${issued}`)
      .digest('base64url');
    if (!safeEqual(mac, expected)) return null;
    return userId;
  }
}

export interface UserRecord {
  id: string;
  displayName: string;
}

export function ensureUser(db: Db, id: string, displayName: string): UserRecord {
  db.$client
    .prepare(
      'INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING',
    )
    .run(id, displayName, nowIso());
  return { id, displayName };
}

export function requireUser(db: Db, id: string | null): string {
  if (!id) throw new AppError('unauthenticated', 'No application session.');
  const row = db.$client.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!row) throw new AppError('unauthenticated', 'Unknown application session.');
  return id;
}
