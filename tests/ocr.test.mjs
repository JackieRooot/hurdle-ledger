// 截图识别的版面分析（不运行 Tesseract，用手工构造的识别结果）。
// 版面仿照券商 App 的“我的资产”页；所有金额、账号都是虚构的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, linesOf, locateAssets, mergeFound, settleAssets } from '../ocr.js';

// 一行：每个词 [文字, x0, x1]，同一行的词高度相同
const line = (y, h, ...words) => ({ words: words.map(([text, x0, x1]) => ({ text, bbox: { x0, y0: y, x1, y1: y + h } })) });

// 第一轮常见的读法：标签的字之间有空格、两个标签读成同一行、金额被拆开或读错、右栏的 “+” 丢失
function page({ total = [['86,420.50', 65, 362]], right = [['+3,210.00', 547, 849]], stock = [['1', 350, 386], ['列', 389, 417], ['5000', 421, 530]] } = {}) {
  return [
    line(38, 30, ['09:30', 69, 150], ['5G', 700, 740]),
    line(402, 33, ['66****1234', 60, 230], ['退出', 785, 849]),
    line(505, 36, ['我', 60, 96], ['的', 110, 133], ['资产', 154, 224]),
    line(603, 31, ['人', 60, 91], ['民', 96, 125], ['币', 136, 167], ['总', 175, 192], ['资产', 209, 260], ['(元', 265, 305], [')', 308, 314],
      ['昨日', 665, 724], ['收益', 746, 796], ['(元', 801, 841], [')', 843, 850]),
    line(667, 53, ...total, ...right),
    line(744, 28, ['清算', 60, 184], ['时间', 190, 260]),
    line(861, 34, ['股票', 60, 133], ...stock, ['|', 560, 584], ['“', 640, 652], ['河', 663, 672], ['1,20000', 680, 812]),
    line(1012, 36, ['理财', 60, 134], ['0.00', 463, 530], ['000', 749, 812]),
    line(1141, 31, ['可', 680, 710], ['用', 719, 742], ['资金', 757, 812]),
    line(1165, 36, ['现金', 60, 134], ['142050', 422, 531], ['1,420.50', 710, 813]),
    line(1434, 34, ['截至', 60, 120], ['10-20', 130, 200], ['收益', 489, 553], ['-12.3', 748, 837]),
    line(1476, 34, ['收益', 489, 553], ['率', 566, 587], ['-1.25%', 748, 857]),
    line(1957, 25, ['首页', 63, 110], ['理财', 656, 707], ['我', 790, 810], ['的', 815, 847]),
  ];
}
// 模拟第二轮：按位置返回读到的文字
function reread(found, map) {
  for (const it of [found.total, ...found.parts]) if (it) it.reread = map(it) ?? '';
  return found;
}
const correct = (it) => ({ 65: '86,420.50', 350: '85,000.00', 463: '0.00', 422: '1,420.50' })[it.bbox.x0];

test('金额文字的解析', () => {
  assert.equal(parseAmount('86,420.50'), 86420.5);
  assert.equal(parseAmount('86420.50'), 86420.5);
  assert.equal(parseAmount('0.00'), 0);
  assert.equal(parseAmount('¥ 1,234.56'), 1234.56);
  assert.equal(parseAmount('１，２３４．５６'), 1234.56, '全角');
  assert.equal(parseAmount('85.000.00'), 85000, '千分位读成小数点');
  assert.equal(parseAmount('1,234,567.89'), 1234567.89);
  for (const bad of ['+3,210.00', '-12.30', '—5.00', '-1.25%', '1.25%', '66****1234', '10-20', '09:30', '85,00000', '1,2345.67', '12.3', '', '列']) {
    assert.equal(parseAmount(bad), null, bad);
  }
});

test('从截图版面找出总资产和分项，并通过分项核对', () => {
  const found = locateAssets(page());
  assert.equal(found.total.text, '86,420.50');
  assert.deepEqual(found.parts.map((p) => p.label), ['股票', '理财', '现金']);
  assert.equal(found.parts[0].text, '1列5000', '被拆开的金额合并成一段');
  assert.deepEqual(found.parts[0].bbox, { x0: 350, y0: 861, x1: 530, y1: 895 }, '不含分隔线右边的当日盈亏');
  assert.equal(found.clearing, true);
  assert.equal(found.hidden, false);
  const r = settleAssets(reread(found, correct));
  assert.equal(r.value, 86420.5);
  assert.equal(r.check, 'ok');
  assert.deepEqual(r.parts, [{ label: '股票', value: 85000 }, { label: '理财', value: 0 }, { label: '现金', value: 1420.5 }]);
  assert.equal(r.partsSum, 86420.5);
  assert.equal(r.warnings.length, 1, '清算时间提示');
  assert.equal(r.error, '');
});

test('同一行右边的昨日收益即使丢了 “+” 也不会被当成总资产', () => {
  const found = locateAssets(page({ right: [['3,210.00', 547, 849]] }));
  assert.equal(found.total.text, '86,420.50');
});

test('第二轮读错时用第一轮的读数凑出一致的组合', () => {
  const found = reread(locateAssets(page()), (it) => (it.bbox.x0 === 65 ? '86,428.50' : correct(it)));
  const r = settleAssets(found);
  assert.equal(r.value, 86420.5);
  assert.equal(r.check, 'ok');
});

test('分项之和对不上时仍填入总资产，但标为不一致', () => {
  const found = reread(locateAssets(page()), (it) => (it.bbox.x0 === 350 ? '85,900.00' : correct(it)));
  const r = settleAssets(found);
  assert.equal(r.value, 86420.5);
  assert.equal(r.check, 'mismatch');
  assert.equal(r.partsSum, 87320.5);
});

test('金额被隐藏（****）时报错，不填入', () => {
  const found = reread(locateAssets(page({ total: [['******', 65, 300]], right: [['****', 547, 700]] })), () => '');
  assert.equal(found.hidden, true);
  assert.equal(found.total, null);
  const r = settleAssets(found);
  assert.equal(r.value, null);
  assert.match(r.error, /隐藏/);
});

test('找不到总资产时报错，不用分项合计代替（漏掉一个分项就会填错）', () => {
  const lines = page().filter((l) => !l.words.some((w) => w.text === '总'));
  const r = settleAssets(reread(locateAssets(lines), correct));
  assert.equal(r.value, null);
  assert.match(r.error, /没能/);
  const none = settleAssets(locateAssets([line(38, 30, ['09:30', 69, 150])]));
  assert.equal(none.value, null);
  assert.match(none.error, /没能/);
});

test('换一个比例再找时补上漏掉的分项，已读过的项不重复', () => {
  const all = page();
  const noStock = all.filter((l) => !l.words.some((w) => w.text === '股票'));
  const first = reread(locateAssets(noStock), correct);
  assert.equal(settleAssets(first).check, 'mismatch');
  const merged = mergeFound(first, locateAssets(all));
  assert.deepEqual(merged.parts.map((p) => p.label), ['股票', '理财', '现金'], '按固定顺序排列');
  assert.equal(merged.total, first.total, '总资产沿用第一次的结果（含第二轮读数）');
  assert.equal(merged.parts[1], first.parts[0]);
  assert.equal(merged.parts[0].reread, undefined, '新找到的分项还需要第二轮');
  const r = settleAssets(reread(merged, (it) => it.reread ?? correct(it)));
  assert.equal(r.check, 'ok');
  assert.equal(r.value, 86420.5);
});

test('标签和金额在同一行的版面', () => {
  const lines = [
    line(100, 30, ['总资产', 20, 110], ['12,345.67', 400, 560]),
    line(160, 30, ['股票', 20, 80], ['12,000.00', 400, 560]),
    line(220, 30, ['现金', 20, 80], ['345.67', 400, 560]),
  ];
  const r = settleAssets(locateAssets(lines));
  assert.equal(r.value, 12345.67);
  assert.equal(r.check, 'ok');
});

test('linesOf 展开 Tesseract 的结果并按比例换算坐标', () => {
  const data = { blocks: [{ paragraphs: [{ lines: [{ words: [{ text: '总资产', bbox: { x0: 10, y0: 20, x1: 30, y1: 40 } }] }] }] }] };
  assert.deepEqual(linesOf(data, 2), [{ words: [{ text: '总资产', bbox: { x0: 20, y0: 40, x1: 60, y1: 80 } }] }]);
  assert.deepEqual(linesOf({ blocks: null }), []);
});
