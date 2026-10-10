// 运行：node --test tests/
// 测试数据单位均为“万元”，仅用于验算，不是真实数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { compute } from '../calc.js';

const close = (a, b, eps = 1e-4, msg) =>
  assert.ok(Math.abs(a - b) <= eps, `${msg || ''} 期望 ${b}，实际 ${a}`);

function data(A, B, flows = [], snapshots = [], date = '2026-01-01') {
  return { settings: {}, inception: { date, me: A, friend: B }, flows, snapshots };
}
const snap = (date, value) => ({ date, value });
const flow = (date, owner, type, amount, valueBefore) => ({ date, owner, type, amount, valueBefore });
const year = (r, y) => r.years.find((x) => x.year === y);

test('例 1：高水位线（A = 0）', () => {
  const r = compute(data(0, 100, [], [snap('2026-12-31', 90), snap('2027-12-31', 110)]), { asOf: '2027-12-31' });
  assert.deepEqual(r.errors, []);
  const y1 = year(r, 2026), y2 = year(r, 2027);
  close(y1.fee, 0); close(y1.Hend, 100);
  close(y2.H0, 100); close(y2.T, 106); close(y2.fee, 1); close(y2.Hend, 109);
  close(r.current.values.friend, 109);
  close(r.current.values.me, 1);
});

test('例 2：未超过门槛（A = 0）', () => {
  const r = compute(data(0, 100, [], [snap('2026-12-31', 105)]), { asOf: '2026-12-31' });
  const y = year(r, 2026);
  close(y.T, 106); close(y.fee, 0); close(y.Hend, 105);
});

test('例 3：两人共有', () => {
  const r = compute(data(50, 100, [], [snap('2026-12-31', 165)]), { asOf: '2026-12-31' });
  const y = year(r, 2026);
  close(y.navEnd, 1.1); close(y.Vf, 110); close(y.T, 106); close(y.fee, 1);
  close(y.transferUnits, 0.9091);
  close(r.current.values.friend, 109);
  close(r.current.values.me, 56);
  close(r.current.me.invGain + r.current.me.start, 55); // 投资部分价值 55
  close(r.current.me.invGain, 5);
  close(r.current.me.fee, 1);
  assert.equal(r.current.me.feeKind, 'settled');
  close(r.current.cumulativeFee, 1);
  close(r.current.friend.net, 9);
  close(r.current.friend.netRate, 0.09);
  close(r.current.ytdReturn, 0.1);
});

test('例 4：年中注资按天数加权', () => {
  const r = compute(data(50, 100, [flow('2026-07-02', 'friend', 'deposit', 20, 150)], [snap('2026-12-31', 182)]), { asOf: '2026-12-31' });
  close(r.flows[0].nav, 1); close(r.flows[0].units, 20);
  const y = year(r, 2026);
  close(y.navEnd, 1.070588); close(y.Vf, 128.4706);
  close(y.T, 126.5984); close(y.fee, 0.4681);
});

test('例 5：首笔投入在年中，门槛仍按全年 6%', () => {
  const r = compute(data(50, 100, [], [snap('2026-09-30', 157.5), snap('2026-12-31', 165)], '2026-07-01'), { asOf: '2026-12-31' });
  const y = year(r, 2026);
  close(y.T, 106); close(y.fee, 1);
  // 季度预估：第一年首笔投入始终按全年 6% 满额，不按已过天数折算
  const q3 = r.snapshots[0];
  close(q3.friend.T, 106);
  assert.equal(q3.friend.feeKind, 'estimate');
  close(q3.friend.fee, 0);
  // 年中季度预估不转移份额
  close(q3.units.friend, 100);
});

test('例 6：我的资金流动不影响朋友的门槛、高水位和分成', () => {
  const base = compute(data(50, 100, [], [snap('2026-12-31', 165)]), { asOf: '2026-12-31' });
  const dep = compute(data(50, 100, [flow('2026-07-02', 'me', 'deposit', 50, 150)], [snap('2026-12-31', 220)]), { asOf: '2026-12-31' });
  const wd = compute(data(50, 100, [flow('2026-07-02', 'me', 'withdraw', 30, 150)], [snap('2026-12-31', 132)]), { asOf: '2026-12-31' });
  for (const r of [dep, wd]) {
    assert.deepEqual(r.errors, []);
    const a = year(base, 2026), b = year(r, 2026);
    close(b.T, a.T); close(b.fee, a.fee); close(b.Hend, a.Hend); close(b.navEnd, 1.1);
  }
  close(dep.current.me.invGain, 50 * 0.1 + 50 * 0.1); // 起始 50 + 注资 50，各涨 10%
});

test('朋友年中提取', () => {
  const r = compute(data(50, 100, [flow('2026-07-02', 'friend', 'withdraw', 20, 150)], [snap('2026-12-31', 143)]), { asOf: '2026-12-31' });
  assert.deepEqual(r.errors, []);
  close(r.flows[0].units, 20);
  const y = year(r, 2026);
  close(y.navEnd, 1.1); close(y.Vf, 88);
  const T = 106 - 20 * (1 + 0.06 * 182 / 365);
  close(y.T, T); close(y.fee, (88 - T) * 0.25);
  close(y.Hend, Math.max(80, 88 - (88 - T) * 0.25));
});

test('朋友提取不能超过 持有价值 − 当时预估分成', () => {
  // 7 月 2 日账户 225（净值 1.5），朋友价值 150；第一年首笔按全年满额，T = 106
  const T = 106;
  const est = (150 - T) * 0.25;
  const bad = compute(data(50, 100, [flow('2026-07-02', 'friend', 'withdraw', 140, 225)], []), { asOf: '2026-07-02' });
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0].msg, /超过可提取金额/);
  const ok = compute(data(50, 100, [flow('2026-07-02', 'friend', 'withdraw', 150 - est - 0.01, 225)], []), { asOf: '2026-07-02' });
  assert.deepEqual(ok.errors, []);
});

test('提取超额时的校验（我和朋友）', () => {
  const r1 = compute(data(50, 100, [flow('2026-07-02', 'me', 'withdraw', 50.01, 150)], []), { asOf: '2026-07-02' });
  assert.equal(r1.errors.length, 1);
  assert.match(r1.errors[0].msg, /超过本人当时持有价值/);
  const r2 = compute(data(50, 100, [flow('2026-07-02', 'friend', 'withdraw', 101, 150)], []), { asOf: '2026-07-02' });
  assert.equal(r2.errors.length, 1);
  // 无效的记录不计入份数
  close(r2.current.units.friend, 100);
  // 全额提取我的部分是允许的，份数为 0 而不是负数
  const r3 = compute(data(50, 100, [flow('2026-07-02', 'me', 'withdraw', 50, 150)], []), { asOf: '2026-07-02' });
  assert.deepEqual(r3.errors, []);
  assert.equal(r3.current.units.me, 0);
});

test('多年连续亏损后回本', () => {
  const r = compute(data(0, 100, [], [
    snap('2026-12-31', 80), snap('2027-12-31', 90), snap('2028-12-31', 105), snap('2029-12-31', 120),
  ]), { asOf: '2029-12-31' });
  close(year(r, 2026).Hend, 100); close(year(r, 2026).fee, 0);
  close(year(r, 2027).T, 106); close(year(r, 2027).fee, 0); close(year(r, 2027).Hend, 100);
  // 2028 闰年，已过天数上限 365，T 仍为 106
  close(year(r, 2028).T, 106); close(year(r, 2028).fee, 0); close(year(r, 2028).Hend, 105);
  close(year(r, 2029).T, 111.3); close(year(r, 2029).fee, (120 - 111.3) * 0.25);
});

test('跨年结转：上年年末值自动作为下一年期初', () => {
  const r = compute(data(50, 100, [], [snap('2026-12-31', 165), snap('2027-06-30', 170), snap('2027-12-31', 181.5)]), { asOf: '2027-12-31' });
  const y1 = year(r, 2026), y2 = year(r, 2027);
  const fu = 100 - 1 / 1.1;
  close(y2.friendStart, 109); close(y2.H0, 109);
  close(y2.Vf, fu * 1.21);
  close(y2.T, 109 * 1.06);
  close(y2.fee, (fu * 1.21 - 109 * 1.06) * 0.25);
  // 相对期初收益率：用 2026 年末净值 1.1
  const q2 = r.snapshots[1];
  close(q2.ytdReturn, (170 / 150) / 1.1 - 1);
  close(q2.periodReturn, (170 / 150) / 1.1 - 1);
  close(r.current.ytdReturn, 0.1);
  close(r.current.cumulativeFee, y1.fee + y2.fee);
  close(r.current.me.start, 56);
});

test('同一天多笔资金流动按录入顺序处理', () => {
  const r = compute(data(50, 100, [
    flow('2026-07-02', 'friend', 'deposit', 20, 150),
    flow('2026-07-02', 'me', 'deposit', 30, 170),
    flow('2026-07-02', 'friend', 'withdraw', 10, 200),
  ], [snap('2026-12-31', 209)]), { asOf: '2026-12-31' });
  assert.deepEqual(r.errors, []);
  r.flows.forEach((f) => close(f.nav, 1));
  close(r.flows[2].unitsAfter.friend, 110);
  close(r.flows[2].unitsAfter.me, 80);
  const y = year(r, 2026);
  close(y.navEnd, 1.1);
  close(y.T, 106 + 10 * (1 + 0.06 * 182 / 365));
  close(y.Hend, Math.max(110, y.Vf - y.fee));
});

test('12 月 31 日当天的资金流动算在当年，分成在之后计算', () => {
  const r = compute(data(50, 100, [flow('2026-12-31', 'friend', 'deposit', 20, 165)], [snap('2026-12-31', 185)]), { asOf: '2026-12-31' });
  assert.deepEqual(r.errors, []);
  const y = year(r, 2026);
  close(r.flows[0].nav, 1.1);
  close(y.navEnd, 1.1);
  close(y.T, 126); // d = 0
  close(y.Vf, 130); close(y.fee, 1);
});

test('缺少年末快照时提示无法结算，之后年份也无法计算', () => {
  const r = compute(data(50, 100, [], [snap('2026-09-30', 160), snap('2027-03-31', 170), snap('2027-12-31', 180)]), { asOf: '2027-12-31' });
  assert.equal(year(r, 2026).status, 'unsettled');
  assert.equal(year(r, 2027).status, 'blocked');
  assert.equal(year(r, 2027).blockedBy, 2026);
  assert.equal(year(r, 2027).fee, null);
  assert.ok(r.warnings.some((w) => w.includes('2026')));
  // 净值、份数、价值照常
  close(r.current.nav, 1.2);
  close(r.current.values.friend, 120);
  assert.equal(r.current.friend.fee, null);
  assert.equal(r.cumulativeFee, 0);
  // 只有一年数据，但日期已到下一年
  const r2 = compute(data(50, 100, [], [snap('2026-09-30', 160)]), { asOf: '2027-02-01' });
  assert.equal(year(r2, 2026).status, 'unsettled');
  assert.equal(r2.current.unsettledYear, 2026);
  // 同一年内则是“进行中”
  const r3 = compute(data(50, 100, [], [snap('2026-09-30', 160)]), { asOf: '2026-10-10' });
  assert.equal(year(r3, 2026).status, 'open');
  assert.deepEqual(r3.warnings, []);
});

test('朋友份数归零时高水位清零，再注资重新开始', () => {
  // 朋友亏损（价值 90 < 门槛）后全部提取，H 清零；之后注资 50
  const r = compute(data(50, 100, [
    flow('2026-04-01', 'friend', 'withdraw', 90, 135),
    flow('2026-07-02', 'friend', 'deposit', 50, 45),
  ], [snap('2026-12-31', 104.5)]), { asOf: '2026-12-31' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.flows[0].hReset, true);
  assert.equal(r.flows[0].unitsAfter.friend, 0);
  const y = year(r, 2026);
  // 再注资 50 时净值 0.9，得 55.5556 份；年末净值 104.5 / 105.5556
  close(y.T, 50 * (1 + 0.06 * 182 / 365));
  assert.ok(y.hReset);
  close(y.Hend, Math.max(50, y.Vf - y.fee));
});

test('数据格式校验', () => {
  const r = compute(data(50, 100, [
    { date: '2026-07-02', owner: 'friend', type: 'deposit', amount: 20 },
    flow('2025-12-01', 'me', 'deposit', 1, 150),
    flow('2026-07-02', 'x', 'deposit', 1, 150),
  ], [snap('2026-09-30', 150), snap('2026-09-30', 151)]), { asOf: '2026-10-01' });
  assert.equal(r.errors.length, 4);
  assert.ok(r.errors.some((e) => /必填/.test(e.msg)));
  assert.ok(r.errors.some((e) => /早于起始日期/.test(e.msg)));
  assert.ok(r.errors.some((e) => /只能有一条快照/.test(e.msg)));
});

test('朋友到手收益率按资金在账天数加权', () => {
  // 全年：期初 100，7/2 注资 20（d=182），年末 Vf 128.4706，分成 0.4681
  const r = compute(data(50, 100, [flow('2026-07-02', 'friend', 'deposit', 20, 150)], [snap('2026-12-31', 182)]), { asOf: '2026-12-31' });
  const y = year(r, 2026);
  const net = y.Vf - y.fee - 100 - 20;
  const base = 100 + 20 * 182 / 364; // 第一年区间起点 = 开户日 1 月 1 日
  close(r.current.friend.net, net);
  close(r.current.friend.netRate, net / base);
});

test('年末门槛线（不提成线）在年中就显示全年数值', () => {
  // 例 5 的数据：9 月 30 日时年末门槛线应为 106
  const r = compute(data(50, 100, [], [snap('2026-09-30', 157.5)], '2026-07-01'), { asOf: '2026-10-10' });
  close(r.current.friend.TYearEnd, 106);
  close(r.current.friend.T, 106); // 第一年首笔不折算
  assert.equal(year(r, 2026).status, 'open');
  close(year(r, 2026).T, 106);
  // 年中注资后：按到年末的天数计算
  const r2 = compute(data(50, 100, [flow('2026-07-02', 'friend', 'deposit', 20, 150)], [snap('2026-09-30', 175)]), { asOf: '2026-10-10' });
  close(r2.current.friend.TYearEnd, 126.5984);
  // 已结算时等于结算用的门槛线
  const r3 = compute(data(50, 100, [], [snap('2026-12-31', 165)]), { asOf: '2026-12-31' });
  close(r3.current.friend.TYearEnd, 106);
});

test('第一年首笔满额、之后注资按天数；第二年起期初高水位在季度预估中按已过天数折算', () => {
  // 第一年 9 月 30 日：首笔 100 满额 106；7 月 2 日注资 20 按到 9 月 30 日的 90 天加权
  const r = compute(data(50, 100, [flow('2026-07-02', 'friend', 'deposit', 20, 150)], [snap('2026-09-30', 175), snap('2026-12-31', 182), snap('2027-03-31', 190)]), { asOf: '2027-04-01' });
  close(r.snapshots[0].friend.T, 106 + 20 * (1 + 0.06 * 90 / 365));
  // 第二年 3 月 31 日：H_期初 按已过 90 天折算
  const y1 = year(r, 2026);
  close(r.snapshots[2].friend.T, y1.Hend * (1 + 0.06 * 90 / 365));
});
