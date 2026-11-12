// Integer hashing. Everything here stays in 32-bit integer math so results are
// identical in every browser and in Node.

/** Mixes three integers into an unsigned 32-bit hash. */
export function hash3(a: number, b: number, c: number): number {
  let h = (a | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (b | 0), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h ^ (c | 0), 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return h >>> 0;
}

/** FNV-1a over the bytes of a typed array, continuing from `h`. */
export function fnv1a(h: number, view: ArrayBufferView, byteLength = view.byteLength): number {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, byteLength);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const FNV_OFFSET = 0x811c9dc5;
