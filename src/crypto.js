import {
  generateKeyPairSync, sign, verify, createHash,
  createPublicKey, createPrivateKey, randomBytes,
} from 'node:crypto';

/** Stable JSON: keys sorted recursively, undefined values dropped. */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
    .join(',') + '}';
}

export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

/** Signs every field of the event except `sig`. Returns base64. */
export function signEvent(event, privatePem) {
  const { sig, ...unsigned } = event;
  return sign(null, Buffer.from(canonical(unsigned)), createPrivateKey(privatePem)).toString('base64');
}

export function verifyEvent(event, publicPem) {
  if (!event || typeof event.sig !== 'string' || !publicPem) return false;
  const { sig, ...unsigned } = event;
  // exactly the base64 the signer wrote: no junk, whitespace or alternate encodings of a signature
  if (Buffer.from(sig, 'base64').toString('base64') !== sig) return false;
  try {
    return verify(null, Buffer.from(canonical(unsigned)), createPublicKey(publicPem), Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

/** Hash of the full signed event; the next event stores this as `prev`. */
export function eventHash(event) {
  return sha256(canonical(event));
}

export function newId(prefix, bytes = 4) {
  return `${prefix}-${randomBytes(bytes).toString('hex')}`;
}
