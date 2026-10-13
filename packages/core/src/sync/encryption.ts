// End-to-end encryption: PBKDF2 (SHA-512, 200k iterations) derives a
// 256-bit AES-GCM key from the user's password and a stored salt. Message
// contents and file snapshots are encrypted before they leave the device.
import { base64ToBytes, bytesToBase64 } from '../util/base64';

const subtle = () => globalThis.crypto.subtle;

export function randomSalt(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToBase64(b);
}

export async function deriveKey(password: string, saltB64: string): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: base64ToBytes(saltB64) as BufferSource, iterations: 200_000, hash: 'SHA-512' },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportKey(key: CryptoKey): Promise<string> {
  return bytesToBase64(new Uint8Array(await subtle().exportKey('raw', key)));
}

export async function importKey(raw: string): Promise<CryptoKey> {
  return subtle().importKey('raw', base64ToBytes(raw) as BufferSource, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

/** Output: 12-byte IV followed by ciphertext and GCM tag. */
export async function encrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, data as BufferSource));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function decrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.subarray(0, 12);
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data.subarray(12) as BufferSource));
}

export async function makeTestContent(key: CryptoKey): Promise<string> {
  return bytesToBase64(await encrypt(key, new TextEncoder().encode('envelope-key-test')));
}

export async function verifyKey(key: CryptoKey, testContent: string): Promise<boolean> {
  try {
    const out = await decrypt(key, base64ToBytes(testContent));
    return new TextDecoder().decode(out) === 'envelope-key-test';
  } catch {
    return false;
  }
}
