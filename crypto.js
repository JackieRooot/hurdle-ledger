// crypto.js —— 浏览器原生 Web Crypto：PBKDF2-SHA256 派生密钥 + AES-GCM-256 加密。
//
// 加密文件格式（二进制）：
//   0..3    魔数 "HLE1"
//   4..7    PBKDF2 迭代次数（uint32，大端）
//   8..23   salt（16 字节，每个文件随机）
//   24..35  IV（12 字节，每个文件随机）
//   36..    AES-GCM 密文（含 16 字节认证标签）
// 文件头（魔数、迭代次数、salt、IV）作为附加认证数据，被篡改时解密失败。
// 在 Node 18+ 中同样可用（globalThis.crypto.subtle），供测试使用。

export const ITERATIONS = 600000;
const MAGIC = [0x48, 0x4c, 0x45, 0x31]; // "HLE1"
const HEADER = 36;

const subtle = () => {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('当前浏览器不支持 Web Crypto，请使用新版 Chrome / Safari / Edge / Firefox，并通过 https 访问。');
  return c.subtle;
};

export class WrongPasswordError extends Error {
  constructor() { super('密码错误，或文件已损坏。'); this.name = 'WrongPasswordError'; }
}
export class BadFormatError extends Error {
  constructor(m) { super(m || '不是有效的加密文件。'); this.name = 'BadFormatError'; }
}

async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

function toU8(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  throw new BadFormatError();
}

export async function encryptBytes(password, bytes, iterations = ITERATIONS) {
  if (!password) throw new Error('密码不能为空');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const header = new Uint8Array(HEADER);
  header.set(MAGIC, 0);
  new DataView(header.buffer).setUint32(4, iterations, false);
  header.set(salt, 8);
  header.set(iv, 24);
  const key = await deriveKey(password, salt, iterations);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, toU8(bytes)));
  const out = new Uint8Array(HEADER + ct.length);
  out.set(header, 0);
  out.set(ct, HEADER);
  return out;
}

export async function decryptBytes(password, buf) {
  const u = toU8(buf);
  if (u.length < HEADER + 16 || MAGIC.some((b, i) => u[i] !== b)) throw new BadFormatError();
  const header = u.slice(0, HEADER);
  const iterations = new DataView(header.buffer).getUint32(4, false);
  if (iterations < 100000 || iterations > 10000000) throw new BadFormatError('加密文件参数异常。');
  const salt = header.slice(8, 24);
  const iv = header.slice(24, 36);
  const key = await deriveKey(password, salt, iterations);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: header }, key, u.slice(HEADER)));
  } catch {
    throw new WrongPasswordError();
  }
}

export async function encryptJSON(password, obj) {
  return encryptBytes(password, new TextEncoder().encode(JSON.stringify(obj)));
}

export async function decryptJSON(password, buf) {
  const bytes = await decryptBytes(password, buf);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BadFormatError('解密成功但内容不是有效的数据。');
  }
}

// 根据文件头判断图片类型（截图加密前为 JPEG 或 WebP）
export function imageMime(bytes) {
  const u = toU8(bytes);
  if (u[0] === 0xff && u[1] === 0xd8) return 'image/jpeg';
  if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && u[8] === 0x57 && u[9] === 0x45) return 'image/webp';
  if (u[0] === 0x89 && u[1] === 0x50) return 'image/png';
  return 'application/octet-stream';
}
