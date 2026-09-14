import { createHmac, randomBytes } from 'node:crypto';

export interface Credentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

export function credentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  const names = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'] as const;
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing credentials: ${missing.join(', ')}`);
  return { apiKey: env.X_API_KEY!, apiSecret: env.X_API_SECRET!, accessToken: env.X_ACCESS_TOKEN!, accessSecret: env.X_ACCESS_TOKEN_SECRET! };
}

function encode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

// JSON body fields are not OAuth 1.0a signature parameters.
export function authorization(method: string, url: string, keys: Credentials, nonce = randomBytes(16).toString('hex'), timestamp = String(Math.floor(Date.now() / 1000))) {
  const parsed = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: keys.apiKey, oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: timestamp,
    oauth_token: keys.accessToken, oauth_version: '1.0',
  };
  const parameters = [...parsed.searchParams.entries(), ...Object.entries(oauth)]
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('&');
  const base = [method.toUpperCase(), `${parsed.origin}${parsed.pathname}`, parameters].map(encode).join('&');
  oauth.oauth_signature = createHmac('sha1', `${encode(keys.apiSecret)}&${encode(keys.accessSecret)}`).update(base).digest('base64');
  return `OAuth ${Object.entries(oauth).sort().map(([key, value]) => `${encode(key)}="${encode(value)}"`).join(', ')}`;
}

export class XError extends Error {
  constructor(public status: number, public retryAt = 0) {
    super(`X API returned HTTP ${status}`); // Never include response bodies, headers, or credentials.
  }
}

// Conservative upper bound for our templates: non-ASCII code points count as
// two (emoji sequences may actually cost less). Short URLs need X's 23 chars.
// This intentionally avoids pretending JS string.length is X's emoji weighting.
export function postTextWeight(text: string) {
  const urlsExpanded = text.replace(/https?:\/\/[^\s]+/g, url => url.length < 23 ? 'x'.repeat(23) : url);
  return Array.from(urlsExpanded.normalize('NFC')).reduce((n, char) => n + (char.codePointAt(0)! <= 0x7f ? 1 : 2), 0);
}
export function validatePostText(text: string) {
  if (!text.trim() || /[\u0000-\u0009\u000b-\u001f\u007f\ufffe\uffff]/u.test(text)
    || Array.from(text).some(c => c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff)
    || postTextWeight(text) > 280) throw new Error('Invalid bot post text');
}

export class XClient {
  constructor(private keys: Credentials, private request: typeof fetch = fetch) {}

  private async call(method: string, path: string, body?: object) {
    const url = `https://api.x.com${path}`;
    let response: Response;
    try {
      response = await this.request(url, {
        method, headers: { Authorization: authorization(method, url, this.keys), 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
    } catch {
      throw new Error('X request failed or timed out; delivery may be uncertain');
    }
    if (!response.ok) {
      const reset = Number(response.headers.get('x-rate-limit-reset')) * 1000;
      const retry = Number(response.headers.get('retry-after')) * 1000 + Date.now();
      throw new XError(response.status, Math.max(Number.isFinite(reset) ? reset : 0, Number.isFinite(retry) ? retry : 0));
    }
    try { return await response.json(); } catch { throw new Error('X response could not be decoded; delivery may be uncertain'); }
  }

  async verifyAccount(expected: string) {
    const result = await this.call('GET', '/2/users/me');
    if (typeof result?.data?.username !== 'string' || result.data.username.toLowerCase() !== expected.toLowerCase()) {
      throw new Error('X credentials do not belong to the configured account');
    }
    return result.data.username as string;
  }

  async post(text: string, replyTo?: string) {
    validatePostText(text);
    if (replyTo && !/^\d+$/.test(replyTo)) throw new Error('Invalid reply post ID');
    const result = await this.call('POST', '/2/tweets', { text, ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}) });
    if (typeof result?.data?.id !== 'string') throw new Error('X returned no post ID; delivery may be uncertain');
    return result.data.id as string;
  }
}
