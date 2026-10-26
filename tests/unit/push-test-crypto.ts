/**
 * Test-only Web Push crypto: generates VAPID and browser subscription keys and decrypts an aes128gcm
 * body (RFC 8291) the way a browser would, so tests can assert the actual notification payload.
 */
const subtle = crypto.subtle;
type Bytes = Uint8Array<ArrayBuffer>;

export const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string): Bytes => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

export async function makeVapidKeys() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { publicKey: b64url(raw), privateKey: jwk.d as string, verifyKey: kp.publicKey };
}

export async function makeBrowserSubscription(endpoint: string) {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { endpoint, p256dh: b64url(pub), auth: b64url(auth), privateKey: kp.privateKey, pub, authBytes: auth };
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const utf8 = (s: string): Bytes => new Uint8Array(new TextEncoder().encode(s));

/** Decrypts an RFC 8291 aes128gcm push body with the browser's private key and auth secret. */
export async function decryptPushBody(body: Bytes, sub: Awaited<ReturnType<typeof makeBrowserSubscription>>): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, sub.privateKey, 256));
  const prkKey = await hmac(sub.authBytes, ecdh);
  const ikm = await hmac(prkKey, concat(utf8('WebPush: info'), new Uint8Array([0]), sub.pub, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0, 1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(utf8('Content-Encoding: nonce'), new Uint8Array([0, 1])))).slice(0, 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  // plain[end] is the 0x02 last-record delimiter.
  return new TextDecoder().decode(plain.slice(0, end));
}

/** Verifies a VAPID JWT (ES256) and returns its claims. */
export async function verifyVapidJwt(jwt: string, key: CryptoKey): Promise<Record<string, unknown>> {
  const [h, p, s] = jwt.split('.');
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(s), utf8(`${h}.${p}`));
  if (!ok) throw new Error('bad VAPID signature');
  return JSON.parse(new TextDecoder().decode(fromB64url(p)));
}
