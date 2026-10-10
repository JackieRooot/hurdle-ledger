import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptJSON, decryptJSON, encryptBytes, decryptBytes, WrongPasswordError, BadFormatError, ITERATIONS, imageMime } from '../crypto.js';

const sample = { settings: { hurdle: 0.06 }, inception: { date: '2026-01-01', me: 1, friend: 2 }, flows: [], snapshots: [] };

test('迭代次数不少于 600000', () => {
  assert.ok(ITERATIONS >= 600000);
});

test('JSON 加密解密往返', async () => {
  const enc = await encryptJSON('正确的密码 123', sample);
  // 密文中不出现明文
  assert.ok(!Buffer.from(enc).toString('latin1').includes('inception'));
  assert.deepEqual(await decryptJSON('正确的密码 123', enc), sample);
});

test('每次加密使用随机的 salt 和 IV', async () => {
  const a = await encryptJSON('pw', sample);
  const b = await encryptJSON('pw', sample);
  assert.notDeepEqual(Buffer.from(a.slice(8, 36)), Buffer.from(b.slice(8, 36)));
});

test('错误密码被拒绝', async () => {
  const enc = await encryptJSON('right', sample);
  await assert.rejects(decryptJSON('wrong', enc), WrongPasswordError);
});

test('被篡改的文件被拒绝', async () => {
  const enc = await encryptBytes('pw', new Uint8Array([1, 2, 3, 4]));
  enc[enc.length - 1] ^= 1;
  await assert.rejects(decryptBytes('pw', enc), WrongPasswordError);
  const enc2 = await encryptBytes('pw', new Uint8Array([1, 2, 3, 4]));
  enc2[10] ^= 1; // 改 salt（属于附加认证数据）
  await assert.rejects(decryptBytes('pw', enc2), WrongPasswordError);
  await assert.rejects(decryptBytes('pw', new Uint8Array(100)), BadFormatError);
});

test('二进制（截图）往返', async () => {
  const img = new Uint8Array(5000).map((_, i) => i % 256);
  img[0] = 0xff; img[1] = 0xd8;
  const enc = await encryptBytes('pw', img);
  const dec = await decryptBytes('pw', enc);
  assert.deepEqual(Buffer.from(dec), Buffer.from(img));
  assert.equal(imageMime(dec), 'image/jpeg');
});
