// calc.js —— 份额法 + 门槛收益 + 高水位线 + 年末分成 的全部计算逻辑。
// 纯函数，无 DOM 依赖，供 index.html、editor.html 和 Node 测试共用。
//
// ───────────────────────── 公式总览 ─────────────────────────
// 参与者：一位管理人（me，不涉及门槛和分成）+ 任意多位出资人（investors）。
//
// 份额：
//   起始净值 = 1；我持有 A 份，每位开户时出资的出资人持有其首笔投入 B_k 份。
//   净值 NAV = 账户总值 / 总份数。
//   资金流动：NAV = valueBefore / 流动前总份数；份数 = 金额 / NAV。
//     注资 → 本人份数 += 份数；提取 → 本人份数 −= 份数。
//   某人持有价值 = 份数 × NAV。
//   中途加入的出资人：开户时投入为 0，第一笔注资按普通资金流动记录。
//
// 每位出资人单独计算（h = 门槛，默认 6%；s = 分成比例，默认 25%；可按人单独设置；年天数固定 365）：
//   已过天数 e = min(365, 计算日 − 上年 12 月 31 日)；开户那一年 e 固定为 365
//   d_i       = 计算日 − 该出资人第 i 笔资金流动日期
//   门槛线 T  = H_期初 × (1 + h × e / 365)
//             + Σ 注资_i × (1 + h × d_i / 365)
//             − Σ 提取_j × (1 + h × d_j / 365)
//   年末计算日 = 12 月 31 日，此时 e = 365（即全年 h），d = 到年末的天数。
//   开户那一年 H_期初 = 开户时首笔投入，按全年 h 满额计算：年末结算和年中的季度预估都不按已过天数折算。
//   中途加入的出资人 H_期初 = 0，第一笔及之后的注资/提取都按在账天数加权；
//   第二年起的 H_期初 在季度预估中按已过天数折算。
//   出资人价值 Vf = 份数 × NAV
//   分成 = max(0, Vf − T) × s（上限为 Vf）
//   年末转移份数 = 分成 / 年末 NAV（出资人 → 我），NAV 与总值不变。
//   年内 H：注资 +金额，提取 −金额；份数归零时 H 清零、重新开始。
//   年末 H_新 = max(年内调整后的 H, 扣除分成后的年末价值)。
//
// 收益率：
//   相对上期 = 本期 NAV / 上期 NAV − 1（第一期与起始 NAV 1 比较）
//   相对期初 = 当前 NAV / 当年期初 NAV − 1（第一年期初 NAV = 1）
//   出资人到手收益 = 当前价值 − 预估分成 − 期初价值 − 年内净注资
//   出资人到手收益率 = 到手收益 / (期初价值 + Σ 注资_i × w_i − Σ 提取_j × w_j)
//     w = (计算日 − 流动日) / (计算日 − 区间起点)；区间起点 = 上年 12 月 31 日，
//     第一年为开户日。
//   我的投资收益 = 我的价值（不含当年分成）− 期初价值 − 年内净注资，收益率同理。
//
// 数据格式（version 2）：
//   settings: { hurdle, share, currency, names: { me } }   默认门槛与分成
//   inception: { date, me }                                 开户日、我的首笔投入 A
//   investors: [{ id, name, initial, hurdle?, share? }]     initial = 开户时投入（中途加入为 0）；
//                                                           hurdle / share 留空表示使用默认值
//   flows: [{ date, owner: 'me' | 出资人 id, type, amount, valueBefore, note }]
//   snapshots: [{ date, period, value, shot, note }]
//   旧格式（inception.friend + names.friend）由 normalizeData 自动转换，
//   原来的朋友成为 id 为 'friend' 的出资人，已有记录不需要修改。
// ──────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
  hurdle: 0.06,
  share: 0.25,
  currency: 'CNY',
  names: { me: '我' },
};
export const DEFAULT_INVESTOR_NAME = '朋友';

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

const blank = (v) => v === '' || v == null;

export function mergeSettings(s) {
  s = s || {};
  return {
    hurdle: Number.isFinite(+s.hurdle) && !blank(s.hurdle) ? +s.hurdle : DEFAULT_SETTINGS.hurdle,
    share: Number.isFinite(+s.share) && !blank(s.share) ? +s.share : DEFAULT_SETTINGS.share,
    currency: s.currency || DEFAULT_SETTINGS.currency,
    names: { me: (s.names && s.names.me) || DEFAULT_SETTINGS.names.me },
  };
}

// 旧格式（只有一位朋友）→ 新格式。已是新格式则原样返回。
export function normalizeData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d.investors)) return d;
  const { friend, ...inception } = d.inception || {};
  const { friend: friendName, ...names } = (d.settings && d.settings.names) || {};
  return {
    ...d,
    version: 2,
    settings: { ...(d.settings || {}), names },
    inception,
    investors: [{ id: 'friend', name: friendName || DEFAULT_INVESTOR_NAME, initial: friend }],
  };
}

export function emptyData({ date, me, friend, names = {} } = {}) {
  return {
    version: 2,
    settings: { ...DEFAULT_SETTINGS, names: { me: names.me || DEFAULT_SETTINGS.names.me } },
    inception: { date, me },
    investors: [{ id: 'friend', name: names.friend || DEFAULT_INVESTOR_NAME, initial: friend }],
    flows: [],
    snapshots: [],
  };
}

// 给新出资人分配一个未使用的编号
export function newInvestorId(data) {
  const used = new Set(((data && data.investors) || []).map((v) => v && v.id));
  let n = used.size + 1;
  while (used.has(`f${n}`)) n++;
  return `f${n}`;
}

/**
 * 整理出资人列表：补上默认值并校验。
 * 返回 [{ id, name, initial, hurdle, share, custom: { hurdle, share }, index }]
 */
export function resolveInvestors(data, S = mergeSettings(data && data.settings), errors = []) {
  const list = [];
  const seen = new Set(['me']);
  ((data && data.investors) || []).forEach((v, i) => {
    const err = (msg) => errors.push({ where: 'investor', index: i, msg });
    if (!v || typeof v !== 'object') return err('出资人格式错误');
    const id = String(v.id ?? '');
    if (!id) return err('出资人缺少编号');
    if (seen.has(id)) return err(`出资人编号重复（${id}）`);
    seen.add(id);
    const initial = blank(v.initial) ? 0 : +v.initial;
    if (!(Number.isFinite(initial) && initial >= 0)) err('开户时投入无效');
    const custom = { hurdle: !blank(v.hurdle), share: !blank(v.share) };
    const hurdle = custom.hurdle ? +v.hurdle : S.hurdle;
    const share = custom.share ? +v.share : S.share;
    if (!(Number.isFinite(hurdle) && hurdle >= 0 && hurdle < 1)) err('门槛收益率必须在 0% 到 100% 之间');
    if (!(Number.isFinite(share) && share >= 0 && share <= 1)) err('分成比例必须在 0% 到 100% 之间');
    list.push({ id, name: String(v.name || '') || `出资人 ${i + 1}`, initial, hurdle, share, custom, index: i });
  });
  return list;
}

// ───── 门槛线 T（见文件头公式） ─────
// ys：当年状态；st：该出资人当年状态；date：计算日。
function hurdleLine(ys, st, date, h) {
  const e = ys.first ? YEAR_DAYS : Math.min(YEAR_DAYS, dayNum(date) - dayNum(`${ys.year - 1}-12-31`));
  let T = st.H0 * (1 + h * e / YEAR_DAYS);
  for (const f of st.hFlows) {
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
 * @param rawData 解密后的 JSON（新旧格式均可）
 * @param opts.asOf 'YYYY-MM-DD'，用于判断哪些年份已经结束（默认今天）
 *
 * 结果中按人分开的数值：units / values / share 以 'me' 和出资人 id 为键；
 * 个人指标在 me 和 inv[id] 中；fee 为所有出资人分成之和。
 */
export function compute(rawData, opts = {}) {
  const data = normalizeData(rawData) || {};
  const S = mergeSettings(data.settings);
  const errors = [];
  const warnings = [];
  const res = {
    settings: S, investors: [], errors, warnings,
    flows: [], snapshots: [], years: [], current: null,
    cumulativeFee: 0, markers: [],
  };

  const invs = resolveInvestors(data, S, errors);
  res.investors = invs;
  const byId = new Map(invs.map((v) => [v.id, v]));
  const inc = data.inception || {};
  const A = +inc.me;
  const B = invs.reduce((a, v) => a + v.initial, 0);
  if (!isValidDate(inc.date)) errors.push({ where: 'inception', msg: '起始日期无效' });
  if (!(Number.isFinite(A) && A >= 0)) errors.push({ where: 'inception', msg: '起始金额（我）无效' });
  if (Number.isFinite(A) && Number.isFinite(B) && A + B <= 0) errors.push({ where: 'inception', msg: '起始总金额必须大于 0' });
  if (errors.length) return res;

  const asOf = opts.asOf || todayStr();
  const incDay = dayNum(inc.date);

  // ── 整理事件：同一天内先按录入顺序处理资金流动，再处理快照 ──
  const events = [];
  (data.flows || []).forEach((f, i) => {
    const msg = checkFlowShape(f, incDay, byId);
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
  const u = { me: A };         // 每个人的份数
  for (const v of invs) u[v.id] = v.initial;
  const totalUnits = () => Object.values(u).reduce((a, x) => a + x, 0);
  const valuesAt = (n) => Object.fromEntries(Object.entries(u).map(([k, x]) => [k, x * n]));
  let nav = 1;                 // 最近已知净值
  let value = A + B;           // 最近已知账户总值
  let lastSnapNav = 1;         // 上期净值（用于“相对上期”）
  let blockedBy = null;        // 第一个无法结算的年份
  let point = { date: inc.date, kind: 'inception' };

  const firstYear = yearOf(inc.date);
  let ys = newYear(firstYear, {
    startDate: inc.date, navStart: 1, first: true,
    H0: Object.fromEntries(invs.map((v) => [v.id, v.initial])),
    v0: { ...u },
  });

  // o.H0 / o.v0：按人的期初高水位 / 期初价值；null 表示无法计算
  function newYear(year, o) {
    const inv = {};
    for (const v of invs) {
      const H0 = o.H0 ? o.H0[v.id] : null;
      inv[v.id] = { H0, Hadj: H0, hFlows: [], v0: o.v0 ? o.v0[v.id] : null, flows: [], resetCount: 0 };
    }
    return {
      year, startDate: o.startDate, navStart: o.navStart, first: !!o.first,
      meV0: o.v0 ? o.v0.me : null, meFlows: [], inv,
      settled: false, row: null, blockedBy,
    };
  }

  // 结束当前年份（未在 12-31 结算的视为无法结算），开始下一年
  function closeYear() {
    const startDate = `${ys.year}-12-31`;
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
      ys = newYear(ys.year + 1, { startDate, navStart: null, H0: null, v0: null });
    } else {
      const r = ys.row;
      ys = newYear(ys.year + 1, {
        startDate, navStart: r.navEnd,
        H0: Object.fromEntries(invs.map((v) => [v.id, r.inv[v.id].Hend])),
        v0: valuesAt(r.navEnd),
      });
    }
  }

  function baseYearRow(y) {
    const inv = {};
    for (const v of invs) {
      const st = y.inv[v.id];
      inv[v.id] = {
        start: st.v0, H0: st.H0,
        deposits: st.flows.filter((f) => f.signed > 0).reduce((a, f) => a + f.signed, 0),
        withdrawals: -st.flows.filter((f) => f.signed < 0).reduce((a, f) => a + f.signed, 0),
        flowCount: st.flows.length, hReset: st.resetCount > 0,
        Vf: null, T: null, fee: null, transferUnits: null, Hend: null,
      };
    }
    return {
      year: y.year, status: 'open', blockedBy: null,
      navEnd: null, fee: null, transferUnits: null, inv,
    };
  }

  // 某时点的个人指标（快照或“当前”）；settled = 当天刚完成年末结算
  function personMetrics(date, navNow, settled) {
    const blocked = ys.blockedBy != null;
    const out = {
      me: { units: u.me, value: u.me * navNow, start: ys.meV0, invGain: null, invRate: null, fee: null, feeKind: null },
      inv: {}, fee: null, feeKind: null,
    };
    for (const v of invs) {
      out.inv[v.id] = {
        units: u[v.id], value: u[v.id] * navNow, start: ys.inv[v.id].v0,
        H: null, T: null, TYearEnd: null, fee: null, feeKind: null, net: null, netRate: null,
      };
    }
    if (blocked) return out;
    const kind = settled ? 'settled' : 'estimate';
    let total = 0;
    for (const v of invs) {
      const st = ys.inv[v.id], o = out.inv[v.id];
      let fee, T, VfNet;
      if (settled) {
        const yi = ys.row.inv[v.id];
        fee = yi.fee; T = yi.T; VfNet = o.value; o.H = yi.Hend;
      } else {
        T = hurdleLine(ys, st, date, v.hurdle); fee = feeFor(o.value, T, v.share); VfNet = o.value - fee; o.H = st.Hadj;
      }
      o.T = T; o.fee = fee; o.feeKind = kind;
      // 年末门槛线（不提成线）：按目前已发生的资金流动，把计算日设为当年 12 月 31 日
      o.TYearEnd = settled ? T : hurdleLine(ys, st, `${ys.year}-12-31`, v.hurdle);
      o.net = VfNet - st.v0 - sum(st.flows);
      const b = weightedBase(st.v0, st.flows, ys.startDate, date);
      o.netRate = b && b > 0 ? o.net / b : null;
      total += fee;
    }
    out.fee = total; out.feeKind = kind;
    out.me.fee = total; out.me.feeKind = kind;
    const VmInv = settled ? out.me.value - total : out.me.value;
    out.me.invGain = VmInv - ys.meV0 - sum(ys.meFlows);
    const mb = weightedBase(ys.meV0, ys.meFlows, ys.startDate, date);
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
      const inv = byId.get(owner); // 管理人为 undefined
      const total = totalUnits();
      const row = { ...f, index: ev.i };
      if (total <= EPS_UNITS) {
        row.error = '总份数为 0，无法计算净值（请新建数据集重新开始）';
        errors.push({ where: 'flow', index: ev.i, msg: row.error }); res.flows.push(row); continue;
      }
      const fnav = vb / total; // 流动前一刻净值
      let units = amt / fnav;
      const ownUnits = u[owner];
      row.nav = fnav;
      if (f.type === 'withdraw') {
        const holding = ownUnits * fnav;
        let limit = holding, est = 0;
        if (inv && ys.blockedBy == null) {
          est = feeFor(holding, hurdleLine(ys, ys.inv[owner], f.date, inv.hurdle), inv.share);
          limit = holding - est;
        }
        if (amt > limit + EPS_MONEY) {
          row.error = inv && est > 0
            ? `提取 ${fmt2(amt)} 超过可提取金额 ${fmt2(limit)}（持有价值 ${fmt2(holding)} − 当时预估分成 ${fmt2(est)}）`
            : `提取 ${fmt2(amt)} 超过本人当时持有价值 ${fmt2(holding)}`;
          errors.push({ where: 'flow', index: ev.i, msg: row.error }); res.flows.push(row); continue;
        }
        if (Math.abs(amt - holding) <= EPS_MONEY || units > ownUnits) units = ownUnits; // 全部提取，避免残留
        u[owner] -= units;
      } else {
        u[owner] += units;
      }
      if (u[owner] < EPS_UNITS) u[owner] = Math.max(0, u[owner]);
      const signed = f.type === 'deposit' ? amt : -amt;
      if (inv) {
        const st = ys.inv[owner];
        st.flows.push({ date: f.date, signed });
        st.hFlows.push({ date: f.date, signed });
        st.Hadj += ys.blockedBy == null ? signed : 0;
        if (u[owner] <= EPS_UNITS) {
          // 出资人份数归零：高水位清零，门槛重新开始
          u[owner] = 0; st.H0 = 0; st.Hadj = 0; st.hFlows = []; st.resetCount++;
          row.hReset = true;
        }
      } else {
        ys.meFlows.push({ date: f.date, signed });
      }
      nav = fnav;
      value = vb + signed;
      row.units = units;
      row.unitsAfter = { ...u };
      row.valueAfter = value;
      res.flows.push(row);
      res.markers.push({ kind: 'flow', date: f.date, owner, type: f.type, amount: amt, index: ev.i });
      point = { date: f.date, kind: 'flow', index: ev.i };
    } else {
      // ── 快照（值为当天所有资金流动之后） ──
      const sn = ev.sn;
      const total = totalUnits();
      const row = { ...sn, index: ev.i };
      if (total <= EPS_UNITS) {
        row.error = '总份数为 0，无法计算净值';
        errors.push({ where: 'snapshot', index: ev.i, msg: row.error }); res.snapshots.push(row); continue;
      }
      const snav = +sn.value / total;
      row.nav = snav;
      row.periodReturn = snav / lastSnapNav - 1;
      row.ytdReturn = ys.navStart ? snav / ys.navStart - 1 : null;
      let settled = false;
      if (isYearEnd(sn.date)) {
        const yr = baseYearRow(ys);
        yr.navEnd = snav;
        if (ys.blockedBy != null) {
          yr.status = 'blocked'; yr.blockedBy = ys.blockedBy;
        } else {
          // 年末结算：分成在当天所有资金流动之后计算，每位出资人分别结算
          let totFee = 0, totUnits = 0;
          for (const v of invs) {
            const st = ys.inv[v.id], yi = yr.inv[v.id];
            const Vf = u[v.id] * snav;
            const T = hurdleLine(ys, st, sn.date, v.hurdle);
            const fee = feeFor(Vf, T, v.share);
            const tu = snav > 0 ? Math.min(fee / snav, u[v.id]) : 0;
            u[v.id] -= tu; u.me += tu;
            if (u[v.id] < EPS_UNITS) u[v.id] = 0;
            // H_新 = max(年内调整后的 H, 扣除分成后的年末价值)；份数归零则清零
            const Hend = u[v.id] === 0 ? 0 : Math.max(st.Hadj, Vf - fee);
            Object.assign(yi, { Vf, T, fee, transferUnits: tu, Hend, Hadj: st.Hadj });
            totFee += fee; totUnits += tu;
            if (fee >= Vf - EPS_MONEY && fee > 0) warnings.push(`${ys.year} 年${v.name}的分成达到其全部价值，已按上限转移全部份额。`);
          }
          Object.assign(yr, { status: 'settled', fee: totFee, transferUnits: totUnits });
          settled = true;
          res.cumulativeFee += totFee;
          res.markers.push({ kind: 'settle', date: sn.date, fee: totFee, units: totUnits });
        }
        ys.settled = true; ys.row = yr;
        res.years.push(yr);
        row.settlement = yr;
      }
      Object.assign(row, {
        units: { ...u },
        values: valuesAt(snav),
        ...personMetrics(sn.date, snav, settled),
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
  const tot = totalUnits();
  const cur = {
    date: lastDate, kind: point.kind, value, nav,
    totalUnits: tot,
    units: { ...u },
    values: valuesAt(nav),
    periodReturn: nav / lastSnapNav - 1,
    ytdReturn: null,
    year: curYear,
  };
  if (point.kind === 'snapshot') {
    const r = res.snapshots.find((x) => x.index === point.index && !x.error);
    cur.periodReturn = r.periodReturn; cur.ytdReturn = r.ytdReturn;
    Object.assign(cur, { me: r.me, inv: r.inv, fee: r.fee, feeKind: r.feeKind });
  } else {
    // 最新的数据点是资金流动：相对上期与最近快照比较
    cur.ytdReturn = ys.navStart ? nav / ys.navStart - 1 : null;
    Object.assign(cur, personMetrics(lastDate, nav, false));
    if (point.kind === 'inception') cur.periodReturn = 0;
  }
  cur.share = Object.fromEntries(Object.entries(u).map(([k, x]) => [k, tot > 0 ? x / tot : 0]));
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
      row.asOf = lastDate;
      for (const v of invs) {
        const c = cur.inv[v.id];
        Object.assign(row.inv[v.id], { Vf: c.value, T: c.TYearEnd, Tnow: c.T, fee: c.fee, Hadj: ys.inv[v.id].Hadj });
      }
      row.fee = cur.fee;
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

function checkFlowShape(f, incDay, investors) {
  if (!f || typeof f !== 'object') return '记录格式错误';
  if (!isValidDate(f.date)) return '日期无效';
  if (dayNum(f.date) < incDay) return '资金流动日期早于起始日期';
  if (f.owner !== 'me' && !investors.has(f.owner)) return '“谁”必须是管理人或已登记的出资人';
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
