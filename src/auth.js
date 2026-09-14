import { hmacBase64Url, timingSafeEqual } from './lib/crypto.js';

export const COOKIE_NAME = 'fbauto_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createSessionToken(secret, ttlMs = SESSION_TTL_MS) {
  const payload = `admin.${Date.now() + ttlMs}`;
  return `${payload}.${await hmacBase64Url(secret, payload)}`;
}

export async function verifySessionToken(token, secret) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [subject, expiresAt, signature] = parts;
  if (subject !== 'admin') return false;
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) < Date.now()) return false;

  return timingSafeEqual(await hmacBase64Url(secret, `${subject}.${expiresAt}`), signature);
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    (header ?? '')
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

export function sessionCookie(token, { secure = true } = {}) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function isAuthenticated(request, secret) {
  const cookies = parseCookies(request.headers.get('cookie') ?? '');
  return verifySessionToken(cookies[COOKIE_NAME], secret);
}
