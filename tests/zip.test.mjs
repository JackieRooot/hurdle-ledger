import test from 'node:test';
import assert from 'node:assert/strict';
import { makeZip, crc32 } from '../zip.js';

test('CRC32', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('ZIP 结构', () => {
  const z = makeZip([{ name: 'data.enc', data: new Uint8Array([1, 2, 3]) }, { name: 'shots/2026Q3.enc', data: new Uint8Array(10) }]);
  const v = new DataView(z.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  const end = z.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  assert.equal(v.getUint16(end + 10, true), 2);
});
