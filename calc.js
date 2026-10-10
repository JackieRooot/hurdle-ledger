// calc.js —— 份额法 + 门槛收益 + 高水位线 + 年末分成 的全部计算逻辑。
// 纯函数，无 DOM 依赖，供 index.html、editor.html 和 Node 测试共用。
//
// ───────────────────────── 公式总览 ─────────────────────────
// 份额：
//   起始净值 = 1；我持有 A 份，朋友持有 B 份。
//   净值 NAV = 账户总值 / 总份数。
//   资金流动：NAV = valueBefore / 流动前总份数；份数 = 金额 / NAV。
//     注资 → 本人份数 += 份数；提取 → 本人份数 −= 份数。
//   某人持有价值 = 份数 × NAV。
//
// 朋友部分（h = 门槛 6%，s = 分成比例 25%，年天数固定 365）：
//   已过天数 e = min(365, 计算日 − 上年 12 月 31 日)
//   d_i       = 计算日 − 第 i 笔朋友资金流动日期
//   门槛线 T  = H_期初 × (1 + h × e / 365)
//             + Σ 朋友注资_i × (1 + h × d_i / 365)
//             − Σ 朋友提取_j × (1 + h × d_j / 365)
//   年末计算日 = 12 月 31 日，此时 e = 365（即全年 6%），d = 到年末的天数。
//   第一年 H_期初 = B，也按全年计算（e 从当年 1 月 1 日起算，不从开户日起算）。
//   朋友价值 Vf = 朋友份数 × NAV
//   分成 = max(0, Vf − T) × s（上限为 Vf）
//   年末转移份数 = 分成 / 年末 NAV（朋友 → 我），NAV 与总值不变。
//   年内 H：朋友注资 +金额，提取 −金额；朋友份数归零时 H 清零、重新开始。
//   年末 H_新 = max(年内调整后的 H, 朋友扣除分成后的年末价值)。
//
// 收益率：
//   相对上期 = 本期 NAV / 上期 NAV − 1（第一期与起始 NAV 1 比较）
//   相对期初 = 当前 NAV / 当年期初 NAV − 1（第一年期初 NAV = 1）
//   朋友到手收益 = 朋友当前价值 − 预估分成 − 期初价值 − 年内净注资
//   朋友到手收益率 = 到手收益 / (期初价值 + Σ 注资_i × w_i − Σ 提取_j × w_j)
//     w = (计算日 − 流动日) / (计算日 − 区间起点)；区间起点 = 上年 12 月 31 日，
//     第一年为开户日。
//   我的投资收益 = 我的价值（不含当年分成）− 期初价值 − 年内净注资，收益率同理。
// ──────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
  hurdle: 0.06,
  share: 0.25,
  currency: 'CNY',
  names: { me: '我', friend: '朋友' },
};

const YEAR_DAYS = 365;
const EPS_UNITS = 1e-9;
const EPS_MONEY = 0.005; // 半分钱以内视为相等

// ───── 日期工具 ─────
export function dayNum(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return NaN;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return NaN;
  return Math.round(t / 86400000);
}
export const isValidDate = (s) => Number.isFinite(dayNum(s));
export const yearOf = (s) => +String(s).slice(0, 4);
export const isYearEnd = (s) => String(s).slice(5) === '12-31';
export function quarterOf(s) {
  const m = +String(s).slice(5, 7);
  return `${yearOf(s)}Q${Math.ceil(m / 3)}`;
}
export const daysBetween = (a, b) => dayNum(b) - dayNum(a);
export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function mergeSettings(s) {
  s = s || {};
  return {
    hurdle: Number.isFinite(+s.hurdle) && s.hurdle !== '' && s.hurdle != null ? +s.hurdle : DEFAULT_SETTINGS.hurdle,
    share: Number.isFinite(+s.share) && s.share !== '' && s.share != null ? +s.share : DEFAULT_SETTINGS.share,
    currency: s.currency || DEFAULT_SETTINGS.currency,
    names: {
      me: (s.names && s.names.me) || DEFAULT_SETTINGS.names.me,
      friend: (s.names && s.names.friend) || DEFAULT_SETTINGS.names.friend,
    },
  };
}

export function emptyData({ date, me, friend, names } = {}) {
  return {
    settings: { ...DEFAULT_SETTINGS, names: { ...DEFAULT_SETTINGS.names, ...(names || {}) } },
    inception: { date, me, friend },
    flows: [],
    snapshots: [],
  };
}

// ───── 门槛线 T（见文件头公式） ─────
// ys：当年状态；date：计算日。
function hurdleLine(ys, date, h) {
  const e = Math.min(YEAR_DAYS, dayNum(date) - dayNum(`${ys.year - 1}-12-31`));
  let T = ys.H0 * (1 + h * e / YEAR_DAYS);
  for (const f of ys.hFlows) {
    const d = dayNum(date) - dayNum(f.date);
    T += f.signed * (1 + h * d / YEAR_DAYS);
  }
  return T;
}

// 分成 = max(0, Vf − T) × s，上限 Vf
function feeFor(Vf, T, s) {
  return Math.min(Math.max(0, Vf - T) * s, Math.max(0, Vf));
}

// 资金加权分母：期初价值 + Σ 带符号金额 × w
function weightedBase(v0, flows, startDate, date) {
  const span = dayNum(date) - dayNum(startDate);
  if (!(span > 0)) return null;
  let base = v0;
  for (const f of flows) base += f.signed * (dayNum(date) - dayNum(f.date)) / span;
  return base;
}

const sum = (arr) => arr.reduce((a, f) => a + f.signed, 0);

/**
 * 主计算函数。
 * @param data 解密后的 JSON
 * @param opts.asOf 'YYYY-MM-DD'，用于判断哪些年份已经结束（默认今天）
 */
export function compute(data, opts = {}) {
  const S = mergeSettings(data && data.settings);
  const h = S.hurdle, s = S.share;
  const errors = [];
  const warnings = [];
  const res = {
    settings: S, errors, warnings,
    flows: [], snapshots: [], years: [], current: null,
    cumulativeFee: 0, markers: [],
  };

  const inc = (data && data.inception) || {};
  const A = +inc.me, B = +inc.friend;
  if (!isValidDate(inc.date)) errors.push({ where: 'inception', msg: '起始日期无效' });
  if (!(Number.isFinite(A) && A >= 0)) errors.push({ where: 'inception', msg: '起始金额（我）无效' });
  if (!(Number.isFinite(B) && B >= 0)) errors.push({ where: 'inception', msg: '起始金额（朋友）无效' });
  if (Number.isFinite(A) && Number.isFinite(B) && A + B <= 0) errors.push({ where: 'inception', msg: '起始总金额必须大于 0' });
  if (errors.length) return res;

  const asOf = opts.asOf || todayStr();
  const incDay = dayNum(inc.date);

  // ── 整理事件：同一天内先按录入顺序处理资金流动，再处理快照 ──
  const events = [];
  (data.flows || []).forEach((f, i) => {
    const msg = checkFlowShape(f, incDay);
    if (msg) { errors.push({ where: 'flow', index: i, msg }); res.flows.push({ ...f, index: i, error: msg }); return; }
    events.push({ kind: 0, day: dayNum(f.date), i, f });
  });
  const seenDates = new Set();
  (data.snapshots || []).forEach((sn, i) => {
    let msg = checkSnapShape(sn, incDay);
    if (!msg && seenDates.has(sn.date)) msg = `同一天（${sn.date}）只能有一条快照`;
    if (msg) { errors.push({ where: 'snapshot', index: i, msg }); res.snapshots.push({ ...sn, index: i, error: msg }); return; }
    seenDates.add(sn.date);
    events.push({ kind: 1, day: dayNum(sn.date), i, sn });
  });
  events.sort((a, b) => a.day - b.day || a.kind - b.kind || a.i - b.i);

  // ── 状态 ──
  let mu = A, fu = B;          // 我 / 朋友 的份数
  let nav = 1;                 // 最近已知净值
  let value = A + B;           // 最近已知账户总值
  let lastSnapNav = 1;         // 上期净值（用于“相对上期”）
  let blockedBy = null;        // 第一个无法结算的年份
  let point = { date: inc.date, kind: 'inception' };

  const firstYear = yearOf(inc.date);
  let ys = newYear(firstYear, {
    startDate: inc.date, navStart: 1, H0: B, v0me: A, v0friend: B,
  });

  function newYear(year, o) {
    return {
      year, startDate: o.startDate, navStart: o.navStart,
      H0: o.H0, Hadj: o.H0, hFlows: [],
      v0: { me: o.v0me, friend: o.v0friend },
      flows: { me: [], friend: [] },
      settled: false, row: null, blockedBy, resetCount: 0,
    };
  }

  // 结束当前年份（未在 12-31 结算的视为无法结算），开始下一年
  function closeYear() {
    if (!ys.settled) {
      const row = baseYearRow(ys);
      if (ys.blockedBy != null) {
        row.status = 'blocked'; row.blockedBy = ys.blockedBy;
      } else {
        row.status = 'unsettled';
        blockedBy = ys.year;
        warnings.push(`${ys.year} 年没有 12 月 31 日的快照，无法结算该年分成；之后年份的门槛、高水位和分成也无法计算。`);
      }
      res.years.push(row);
      ys = newYear(ys.year + 1, {
        startDate: `${ys.year}-12-31`, navStart: null, H0: null, v0me: null, v0friend: null,
      });
    } else {
      const r = ys.row;
      ys = newYear(ys.year + 1, {
        startDate: `${ys.year}-12-31`, navStart: r.navEnd, H0: r.Hend,
        v0me: mu * r.navEnd, v0friend: fu * r.navEnd,
      });
    }
  }

  function baseYearRow(y) {
    const dep = y.flows.friend.filter((f) => f.signed > 0).reduce((a, f) => a + f.signed, 0);
    const wd = -y.flows.friend.filter((f) => f.signed < 0).reduce((a, f) => a + f.signed, 0);
    return {
      year: y.year, status: 'open', blockedBy: null,
      friendStart: y.v0.friend, H0: y.H0,
      deposits: dep, withdrawals: wd, flowCount: y.flows.friend.length,
      Vf: null, T: null, fee: null, transferUnits: null, Hend: null, navEnd: null,
      hReset: y.resetCount > 0,
    };
  }

  // 某时点的个人指标（快照或“当前”）
  function personMetrics(date, navNow, settledFee) {
    const blocked = ys.blockedBy != null;
    const Vf = fu * navNow, Vm = mu * navNow;
    const out = {
      friend: { units: fu, value: Vf, start: ys.v0.friend, H: null, T: null, fee: null, feeKind: null, net: null, netRate: null },
      me: { units: mu, value: Vm, start: ys.v0.me, invGain: null, invRate: null, fee: null, feeKind: null },
    };
    if (blocked) return out;
    let fee, T, VfNet, VmInv;
    if (settledFee != null) {
      fee = settledFee; T = ys.row.T; VfNet = Vf; VmInv = Vm - fee;
      out.friend.H = ys.row.Hend;
      out.friend.feeKind = out.me.feeKind = 'settled';
    } else {
      T = hurdleLine(ys, date, h); fee = feeFor(Vf, T, s); VfNet = Vf - fee; VmInv = Vm;
      out.friend.H = ys.Hadj;
      out.friend.feeKind = out.me.feeKind = 'estimate';
    }
    out.friend.T = T; out.friend.fee = fee; out.me.fee = fee;
    const fNet = sum(ys.flows.friend), mNet = sum(ys.flows.me);
    out.friend.net = VfNet - ys.v0.friend - fNet;
    const fb = weightedBase(ys.v0.friend, ys.flows.friend, ys.startDate, date);
    out.friend.netRate = fb && fb > 0 ? out.friend.net / fb : null;
    out.me.invGain = VmInv - ys.v0.me - mNet;
    const mb = weightedBase(ys.v0.me, ys.flows.me, ys.startDate, date);
    out.me.invRate = mb && mb > 0 ? out.me.invGain / mb : null;
    return out;
  }

  for (const ev of events) {
    const evYear = yearOf(ev.f ? ev.f.date : ev.sn.date);
    while (ys.year < evYear) closeYear();

    if (ev.kind === 0) {
      // ── 资金流动 ──
      const f = ev.f;
      const owner = f.owner, amt = +f.amount, vb = +f.valueBefore;
      const total = mu + fu;
      const row = { ...f, index: ev.i };
      if (total <= EPS_UNITS) {
        row.error = '总份数为 0，无法计算净值（请新建数据集重新开始）';
        errors.push({ where: 'flow', index: ev.i, msg: row.error }); res.flows.push(row); continue;
      }
      const fnav = vb / total; // 流动前一刻净值
      let units = amt / fnav;
      const ownUnits = owner === 'me' ? mu : fu;
      row.nav = fnav;
      if (f.type === 'withdraw') {
        const holding = ownUnits * fnav;
        let limit = holding, est = 0;
        if (owner === 'friend' && ys.blockedBy == null) {
          est = feeFor(holding, hurdleLine(ys, f.date, h), s);
          limit = holding - est;
        }
        if (amt > limit + EPS_MONEY) {
          row.error = owner === 'friend' && est > 0
            ? `提取 ${fmt2(amt)} 超过可提取金额 ${fmt2(limit)}（持有价值 ${fmt2(holding)} − 当时预估分成 ${fmt2(est)}）`
            : `提取 ${fmt2(amt)} 超过本人当时持有价值 ${fmt2(holding)}`;
          errors.push({ where: 'flow', index: ev.i, msg: row.error }); res.flows.push(row); continue;
        }
        if (Math.abs(amt - holding) <= EPS_MONEY || units > ownUnits) units = ownUnits; // 全部提取，避免残留
        if (owner === 'me') mu -= units; else fu -= units;
      } else {
        if (owner === 'me') mu += units; else fu += units;
      }
      if (mu < EPS_UNITS) mu = Math.max(0, mu);
      if (fu < EPS_UNITS) fu = Math.max(0, fu);
      const signed = f.type === 'deposit' ? amt : -amt;
      ys.flows[owner].push({ date: f.date, signed });
      if (owner === 'friend') {
        ys.hFlows.push({ date: f.date, signed });
        ys.Hadj += ys.blockedBy == null ? signed : 0;
        if (fu <= EPS_UNITS) {
          // 朋友份数归零：高水位清零，门槛重新开始
          fu = 0; ys.H0 = 0; ys.Hadj = 0; ys.hFlows = []; ys.resetCount++;
          row.hReset = true;
        }
      }
      nav = fnav;
      value = vb + signed;
      row.units = units;
      row.unitsAfter = { me: mu, friend: fu };
      row.valueAfter = value;
      res.flows.push(row);
      res.markers.push({ kind: 'flow', date: f.date, owner, type: f.type, amount: amt, index: ev.i });
      point = { date: f.date, kind: 'flow', index: ev.i };
    } else {
      // ── 快照（值为当天所有资金流动之后） ──
      const sn = ev.sn;
      const total = mu + fu;
      const row = { ...sn, index: ev.i };
      if (total <= EPS_UNITS) {
        row.error = '总份数为 0，无法计算净值';
        errors.push({ where: 'snapshot', index: ev.i, msg: row.error }); res.snapshots.push(row); continue;
      }
      const snav = +sn.value / total;
      row.nav = snav;
      row.periodReturn = snav / lastSnapNav - 1;
      row.ytdReturn = ys.navStart ? snav / ys.navStart - 1 : null;
      let settledFee = null;
      if (isYearEnd(sn.date)) {
        const yr = baseYearRow(ys);
        yr.navEnd = snav;
        if (ys.blockedBy != null) {
          yr.status = 'blocked'; yr.blockedBy = ys.blockedBy;
        } else {
          // 年末结算：分成在当天所有资金流动之后计算
          const Vf = fu * snav;
          const T = hurdleLine(ys, sn.date, h);
          const fee = feeFor(Vf, T, s);
          const tu = Math.min(fee / snav, fu);
          fu -= tu; mu += tu;
          if (fu < EPS_UNITS) fu = 0;
          // H_新 = max(年内调整后的 H, 朋友扣除分成后的年末价值)；份数归零则清零
          const Hend = fu === 0 ? 0 : Math.max(ys.Hadj, Vf - fee);
          Object.assign(yr, { status: 'settled', Vf, T, fee, transferUnits: tu, Hend, Hadj: ys.Hadj });
          settledFee = fee;
          res.cumulativeFee += fee;
          if (fee >= Vf - EPS_MONEY && fee > 0) warnings.push(`${ys.year} 年分成达到朋友全部价值，已按上限转移全部份额。`);
          res.markers.push({ kind: 'settle', date: sn.date, fee, units: tu });
        }
        ys.settled = true; ys.row = yr;
        res.years.push(yr);
        row.settlement = yr;
      }
      Object.assign(row, {
        units: { me: mu, friend: fu },
        values: { me: mu * snav, friend: fu * snav },
        ...personMetrics(sn.date, snav, settledFee),
      });
      row.cumulativeFee = res.cumulativeFee;
      nav = snav; value = +sn.value; lastSnapNav = snav;
      res.snapshots.push(row);
      point = { date: sn.date, kind: 'snapshot', index: ev.i };
    }
  }

  // ── 当前状态 ──
  const lastDate = point.date;
  const curYear = ys.year;
  const settledNow = ys.settled && point.kind === 'snapshot' && isYearEnd(point.date);
  const cur = {
    date: lastDate, kind: point.kind, value, nav,
    totalUnits: mu + fu,
    units: { me: mu, friend: fu },
    values: { me: mu * nav, friend: fu * nav },
    periodReturn: nav / lastSnapNav - 1,
    ytdReturn: null,
    year: curYear,
  };
  if (point.kind === 'snapshot') {
    const r = res.snapshots.find((x) => x.index === point.index && !x.error);
    cur.periodReturn = r.periodReturn; cur.ytdReturn = r.ytdReturn;
    Object.assign(cur, { friend: r.friend, me: r.me });
  } else {
    // 最新的数据点是资金流动：相对上期与最近快照比较
    cur.ytdReturn = ys.navStart ? nav / ys.navStart - 1 : null;
    Object.assign(cur, personMetrics(lastDate, nav, null));
    if (point.kind === 'inception') cur.periodReturn = 0;
  }
  cur.share = cur.totalUnits > 0 ? { me: mu / cur.totalUnits, friend: fu / cur.totalUnits } : { me: 0, friend: 0 };
  cur.cumulativeFee = res.cumulativeFee;
  cur.blockedBy = ys.blockedBy;
  res.current = cur;

  // 当前年份：若尚未结算，追加“进行中”行；若 asOf 显示已过年末，则继续关闭
  const asOfYear = yearOf(asOf);
  while (ys.year < asOfYear) closeYear();
  if (!ys.settled) {
    const row = baseYearRow(ys);
    if (ys.blockedBy != null) { row.status = 'blocked'; row.blockedBy = ys.blockedBy; }
    else if (ys.year === curYear) {
      row.status = 'open';
      row.Vf = cur.friend.value; row.T = cur.friend.T; row.fee = cur.friend.fee;
      row.Hadj = ys.Hadj; row.asOf = lastDate;
    }
    // 没有任何数据的新年份（例如结算后进入的下一年）不显示
    if (ys.year === curYear || row.status === 'blocked') res.years.push(row);
  }
  // 最新数据所在的年份已经过去，但没有 12 月 31 日快照
  const curRow = res.years.find((y) => y.year === curYear);
  if (curRow && curRow.status === 'unsettled') res.current.unsettledYear = curYear;
  const byDate = (a, b) => (dayNum(a.date) || 0) - (dayNum(b.date) || 0) || a.index - b.index;
  res.flows.sort(byDate);
  res.snapshots.sort(byDate);
  return res;
}

const NF2 = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmt2(x) { return NF2.format(x); }

function checkFlowShape(f, incDay) {
  if (!f || typeof f !== 'object') return '记录格式错误';
  if (!isValidDate(f.date)) return '日期无效';
  if (dayNum(f.date) < incDay) return '资金流动日期早于起始日期';
  if (f.owner !== 'me' && f.owner !== 'friend') return '“谁”只能是 me 或 friend';
  if (f.type !== 'deposit' && f.type !== 'withdraw') return '类型只能是注资或提取';
  if (!(Number.isFinite(+f.amount) && +f.amount > 0) || f.amount === '' || f.amount == null) return '金额必须大于 0';
  if (!(Number.isFinite(+f.valueBefore) && +f.valueBefore > 0) || f.valueBefore === '' || f.valueBefore == null) return '“当时账户总值”为必填项，且必须大于 0';
  return null;
}

function checkSnapShape(sn, incDay) {
  if (!sn || typeof sn !== 'object') return '记录格式错误';
  if (!isValidDate(sn.date)) return '日期无效';
  if (dayNum(sn.date) < incDay) return '快照日期早于起始日期';
  if (!(Number.isFinite(+sn.value) && +sn.value >= 0) || sn.value === '' || sn.value == null) return '账户总值无效';
  return null;
}

// 编辑页使用：返回所有错误信息（字符串）
export function validate(data, opts) {
  return compute(data, opts).errors;
}
