// Workers 沒有 node:crypto,一律用標準的 WebCrypto(Node 20+ 也內建,測試可共用)。

const encoder = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hmacHex(secret, data) {
  const key = await hmacKey(secret);
  const payload = typeof data === 'string' ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.sign('HMAC', key, payload));
}

export async function hmacBase64Url(secret, data) {
  const key = await hmacKey(secret);
  return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

/** 不隨內容提早結束的比對,避免用回應時間猜出密碼或簽章。 */
export function timingSafeEqual(a, b) {
  const left = encoder.encode(String(a ?? ''));
  const right = encoder.encode(String(b ?? ''));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function randomId() {
  return crypto.randomUUID();
}
