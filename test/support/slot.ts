/** The text a cluster hashes for `key`: the first non-empty `{...}` section, or the whole key. */
export function hashedPart(key: Buffer): Buffer {
  const open = key.indexOf('{');
  if (open === -1) return key;
  const close = key.indexOf('}', open + 1);
  if (close === -1 || close === open + 1) return key;
  return key.subarray(open + 1, close);
}

/** CRC16-CCITT (XMODEM), the cluster's key hash. */
function crc16(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** The hash slot of `key`, as `CLUSTER KEYSLOT` computes it (UTF-8, as both clients send keys). */
export function keySlot(key: string): number {
  return crc16(hashedPart(Buffer.from(key, 'utf8'))) % 16384;
}

/** Keys that break a naive `{key}` tag: braces, an empty key, percent signs, multibyte text. */
export const HARD_KEYS = [
  '',
  '}',
  '{',
  '{}',
  '}{',
  'a{b}c',
  '{x}',
  'x}y{z',
  '%7B',
  '%',
  'ключ',
  '\u{1F512}',
  'jobs:export',
  '{}{}}}{{',
];
