import crypto from 'node:crypto';

const COOKIE_NAME = 'fbauto_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function createSessionToken(secret, ttlMs = SESSION_TTL_MS) {
  const expiresAt = Date.now() + ttlMs;
  const payload = `admin.${expiresAt}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token, secret) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [subject, expiresAt, signature] = parts;
  if (subject !== 'admin') return false;
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) < Date.now()) return false;

  const expected = sign(`${subject}.${expiresAt}`, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

export { COOKIE_NAME, SESSION_TTL_MS };
