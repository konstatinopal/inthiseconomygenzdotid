// The engine expects a few web APIs that React Native's JavaScript engine
// (Hermes) doesn't provide. Import this before anything from @envelope/core.
import * as Crypto from 'expo-crypto';

const g = globalThis as any;

if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = <T extends ArrayBufferView>(array: T): T => Crypto.getRandomValues(array as any) as T;
}
if (typeof g.crypto.randomUUID !== 'function') {
  g.crypto.randomUUID = () => Crypto.randomUUID();
}

if (typeof g.TextDecoder !== 'function') {
  // Minimal UTF-8 decoder (the engine only decodes UTF-8).
  g.TextDecoder = class {
    decode(input?: ArrayBufferView | ArrayBuffer): string {
      if (!input) return '';
      const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let out = '';
      for (let i = 0; i < bytes.length; ) {
        const b = bytes[i++];
        let cp = b;
        if (b >= 0xf0) cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        else if (b >= 0xe0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        else if (b >= 0xc0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
        out += String.fromCodePoint(cp);
      }
      return out;
    }
  };
}
