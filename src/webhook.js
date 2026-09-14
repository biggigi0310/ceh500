import { hmacHex, timingSafeEqual } from './lib/crypto.js';

/** 驗證 X-Hub-Signature-256,確認請求真的來自 Facebook 而不是別人偽造的。 */
export async function verifySignature(rawBody, headerValue, appSecret) {
  if (!appSecret) return false;
  if (typeof headerValue !== 'string' || !headerValue.startsWith('sha256=')) return false;
  const expected = await hmacHex(appSecret, rawBody);
  return timingSafeEqual(expected, headerValue.slice('sha256='.length));
}

/** Facebook 設定 webhook 時的驗證握手。 */
export function handleVerification(url, verifyToken) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && verifyToken && timingSafeEqual(token ?? '', verifyToken)) {
    return new Response(challenge ?? '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}
