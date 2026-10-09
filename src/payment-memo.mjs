import { bech32, bech32m } from '@scure/base';
import { blake2b } from '@noble/hashes/blake2b';
const utf8 = new TextEncoder();
const invalid = () => {
  throw Error('Invalid shielded address or payment memo');
};
// ZIP-316 inverse F4Jumble; decoding only, no wallet keys or signing.
export function unjumble(bytes) {
  const data = Uint8Array.from(bytes);
  if (data.length < 48 || data.length > 1024) invalid();
  const left = data.subarray(0, Math.min(64, Math.floor(data.length / 2)));
  const right = data.subarray(left.length);
  const xor = (target, hash) => {
    for (let n = 0; n < target.length; n++) target[n] ^= hash[n];
  };
  for (const round of [1, 0]) {
    const personal = new Uint8Array(16);
    personal.set(utf8.encode('UA_F4Jumble_H'));
    personal[13] = round;
    xor(left, blake2b(right, { dkLen: left.length, personalization: personal }));
    personal[12] = 71;
    for (let j = 0; j < Math.ceil(right.length / 64); j++) {
      personal[14] = j & 255;
      personal[15] = j >> 8;
      xor(
        right.subarray(j * 64, Math.min((j + 1) * 64, right.length)),
        blake2b(left, { dkLen: 64, personalization: personal }),
      );
    }
  }
  return data;
}
export function validateShieldedAddress(value, network) {
  if (typeof value !== 'string' || value.length > 1600 || value !== value.toLowerCase()) invalid();
  if (!['mainnet', 'testnet'].includes(network)) invalid();
  const sapling = network === 'mainnet' ? 'zs' : 'ztestsapling';
  if (value.startsWith(sapling + '1')) {
    const decoded = bech32.decode(value, 1600);
    if (decoded.prefix !== sapling || bech32.fromWords(decoded.words).length !== 43) invalid();
    return value;
  }
  const hrp = network === 'mainnet' ? 'u' : 'utest';
  const decoded = bech32m.decode(value, 1600);
  if (decoded.prefix !== hrp) invalid();
  const data = unjumble(bech32m.fromWords(decoded.words));
  const padding = new Uint8Array(16);
  padding.set(utf8.encode(hrp));
  if (!data.subarray(data.length - 16).every((b, i) => b === padding[i])) invalid();
  const body = data.subarray(0, data.length - 16);
  let pos = 0,
    last = -1,
    shielded = false,
    transparent = false;
  const compact = () => {
    if (pos >= body.length) invalid();
    const marker = body[pos++];
    if (marker < 253) return marker;
    const size = marker === 253 ? 2 : marker === 254 ? 4 : 8;
    if (size === 8 || pos + size > body.length) invalid();
    let n = 0;
    for (let i = 0; i < size; i++) n += body[pos++] * 2 ** (8 * i);
    if (n < (size === 2 ? 253 : 65536) || n > 0x2000000) invalid();
    return n;
  };
  while (pos < body.length) {
    const type = compact(),
      length = compact();
    if (type <= last || pos + length > body.length) invalid();
    last = type;
    if (type <= 1) {
      if (transparent || length !== 20) invalid();
      transparent = true;
    }
    if (type === 2 || type === 3) {
      if (length !== 43) invalid();
      shielded = true;
    }
    pos += length;
  }
  if (!shielded) invalid();
  return value;
}
export function parsePaymentMemo(text, network) {
  if (typeof text !== 'string' || utf8.encode(text).length > 512) invalid();
  const legacy = /^zucchini:([A-Za-z0-9_-]{1,128})$/.exec(text);
  if (legacy) return { version: 0, orderId: legacy[1] };
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    invalid();
  }
  if (
    !m ||
    Array.isArray(m) ||
    Object.keys(m).sort().join(',') !== 'order,reply,v' ||
    m.v !== 1 ||
    !/^[a-f0-9-]{36}$/.test(m.order)
  )
    invalid();
  if (JSON.stringify({ v: 1, order: m.order, reply: m.reply }) !== text) invalid();
  return { version: 1, orderId: m.order, replyAddress: validateShieldedAddress(m.reply, network) };
}
export function paymentMemo(order) {
  return order.paymentMemo ?? `zucchini:${order.id}`;
}
export function createPaymentMemo(id, reply, network) {
  const text = JSON.stringify({ v: 1, order: id, reply: validateShieldedAddress(reply, network) });
  parsePaymentMemo(text, network);
  return text;
}
export function matchesPaymentMemo(receipt, order) {
  if (receipt.memo !== paymentMemo(order)) return false;
  if (!order.paymentMemo) return true;
  try {
    const m = parsePaymentMemo(receipt.memo, order.network);
    return m.orderId === order.id && m.replyAddress === order.replyAddress;
  } catch {
    return false;
  }
}
