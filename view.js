// view.js —— 把 calc.js 的计算结果渲染成页面（查看页与编辑页预览共用）。
import { dayNum, isYearEnd, normalizeData } from './calc.js';

// ───── 格式化 ─────
const nf2 = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf4 = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const ok = (x) => x != null && Number.isFinite(x);
export const money = (x) => (ok(x) ? '¥' + nf2.format(Math.abs(x) < 0.005 ? 0 : x) : '—');
export const units = (x) => (ok(x) ? nf4.format(x) : '—');
export const navf = units;
export const pct = (x) => (ok(x) ? nf2.format(x * 100) + '%' : '—');
export const signed = (x, f = money) => (ok(x) ? `<span class="${x > 0.00005 ? 'pos' : x < -0.00005 ? 'neg' : ''}">${x > 0.00005 ? '+' : ''}${f(x)}</span>` : '—');
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 密码框保持 type="password"，浏览器的密码管理器才能保存和自动填充。
// “显示”按钮把它切换成普通文本框：此时输入法（包括输入法里的短语）可以正常使用。
// 提交表单时自动切回 password 类型，方便密码管理器识别并保存。
export function setupPasswordFields(root = document) {
  root.querySelectorAll('input.pw').forEach((input) => {
    if (input.dataset.pwReady) return;
    input.dataset.pwReady = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    // data-mask="css"：不是密码框（不让密码管理器保存），用 CSS 显示为圆点
    const css = input.dataset.mask === 'css';
    const isHidden = () => (css ? input.classList.contains('masked') : input.type === 'password');
    const sync = () => {
      const hidden = isHidden();
      btn.textContent = hidden ? '显示' : '隐藏';
      btn.setAttribute('aria-label', hidden ? '显示密码' : '隐藏密码');
    };
    btn.addEventListener('click', () => {
      if (css) input.classList.toggle('masked');
      else input.type = input.type === 'password' ? 'text' : 'password';
      sync();
      input.focus();
    });
    if (input.form) input.form.addEventListener('submit', () => { if (css) input.classList.add('masked'); else input.type = 'password'; sync(); }, true);
    wrap.appendChild(btn);
    sync();
  });
}

// ───── 表格排序：点表头排序，再点一次反向；默认按日期（第一列）新的在上 ─────
const sortState = new Map(); // 表格 key → { col, dir }，重新渲染后保持用户选的排序

function cellValue(td) {
  if (!td) return null;
  const raw = (td.dataset.v ?? td.textContent).trim();
  if (raw === '' || raw === '—' || raw === '无') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const n = Number(raw.replace(/（[^）]*）/g, '').replace(/[¥,%+\s]/g, '').replace(/^[−-]/, '-'));
  return Number.isFinite(n) ? n : raw;
}

export function makeSortable(table, key) {
  const ths = [...table.tHead.rows[0].cells];
  const tbody = table.tBodies[0];
  const rows = [...tbody.rows];
  const empty = rows.length === 1 && rows[0].cells.length === 1;
  const apply = () => {
    const st = sortState.get(key) || { col: 0, dir: 'desc' };
    ths.forEach((th, i) => {
      const ind = th.querySelector('.sort-ind');
      if (ind) ind.textContent = i === st.col ? (st.dir === 'desc' ? '▼' : '▲') : '';
      th.setAttribute('aria-sort', i === st.col ? (st.dir === 'desc' ? 'descending' : 'ascending') : 'none');
    });
    if (empty) return;
    const sign = st.dir === 'desc' ? -1 : 1;
    const keyed = rows.map((r, i) => ({ r, i, v: cellValue(r.cells[st.col]) }));
    keyed.sort((a, b) => {
      // 空值总在最后；同值时保持原顺序（同一天的资金流动保持录入顺序）
      if (a.v == null || b.v == null) return a.v == null && b.v == null ? a.i - b.i : a.v == null ? 1 : -1;
      const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v), 'zh-CN');
      return c !== 0 ? sign * c : (st.dir === 'desc' ? a.i - b.i : b.i - a.i);
    });
    tbody.append(...keyed.map((k) => k.r));
  };
  ths.forEach((th, i) => {
    if (th.hasAttribute('data-nosort')) return;
    th.classList.add('sortable');
    th.title = '点击排序';
    th.insertAdjacentHTML('beforeend', '<span class="sort-ind"></span>');
    th.addEventListener('click', () => {
      const st = sortState.get(key) || { col: 0, dir: 'desc' };
      sortState.set(key, st.col === i ? { col: i, dir: st.dir === 'desc' ? 'asc' : 'desc' } : { col: i, dir: 'desc' });
      apply();
    });
  });
  apply();
}

const typeName = (t) => (t === 'deposit' ? '注资' : '提取');

// 参与者：管理人在最后；出资人按登记顺序，颜色循环使用 --p0…--p5
export function people(res) {
  const S = res.settings;
  const list = res.investors.map((v, i) => ({ ...v, color: `var(--p${i % 6})`, role: '出资人' }));
  list.push({ id: 'me', name: S.names.me, color: 'var(--me)', role: '管理人' });
  return list;
}
export const nameOf = (res, id) => (id === 'me' ? res.settings.names.me : (res.investors.find((v) => v.id === id) || {}).name || id);
const rateNote = (v) => (v.custom && (v.custom.hurdle || v.custom.share) ? `<span class="tag">门槛 ${pct(v.hurdle)} · 分成 ${pct(v.share)}</span>` : '');

// ───── 主渲染 ─────
/**
 * @param root    容器元素
 * @param data    原始数据（新旧格式均可）
 * @param res     compute(data) 的结果
 * @param opts.onShot(snapshotRow)  点击季度行查看截图
 */
export function renderDashboard(root, data, res, opts = {}) {
  data = normalizeData(data);
  const S = res.settings;
  const cur = res.current;
  const ppl = people(res);
  const invs = ppl.filter((p) => p.id !== 'me');
  const html = [];

  // 提示
  if (res.errors.length) {
    html.push(`<div class="banner err"><b>数据有错误，以下记录未计入：</b><ul>${res.errors.map((e) => `<li>${esc(describeWhere(data, e))}：${esc(e.msg)}</li>`).join('')}</ul></div>`);
  }
  if (res.warnings.length) {
    html.push(`<div class="banner warn"><ul>${res.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`);
  }
  if (!cur) { root.innerHTML = html.join(''); return; }

  const blocked = cur.blockedBy != null;
  const unsettled = cur.unsettledYear != null;
  const feeLabel = cur.feeKind === 'settled' ? '已结算' : '预估';

  // 账户概览
  html.push(`<h2>账户概览 <span class="muted small">截至 ${esc(cur.date)}${cur.kind === 'flow' ? '（最近一笔资金流动后）' : ''}</span></h2>
  <div class="grid kpi">
    ${kpi('当前账户总值', money(cur.value))}
    ${kpi('当前净值', navf(cur.nav), `总份数 ${units(cur.totalUnits)}`)}
    ${kpi('相对上期收益率', signed(cur.periodReturn, pct), '与上一次季度记录的净值相比')}
    ${kpi(`相对期初收益率（${cur.year} 年）`, signed(cur.ytdReturn, pct), '与当年期初净值相比')}
  </div>`);

  // 个人卡片：每位出资人一张（当年没有任何份额和资金流动的不显示），最后是管理人
  const blockNote = blocked ? `<p class="small muted">无法计算（因 ${cur.blockedBy} 年未结算）</p>` : unsettled ? `<p class="small muted">${cur.unsettledYear} 年已结束但缺少 12 月 31 日快照，无法结算，以下为截至最后记录日的预估。</p>` : '';
  const cards = [];
  for (const v of invs) {
    const f = cur.inv[v.id];
    const yearFlows = flowsOf(res, cur.year, v.id);
    if (!(f.units > 0) && !(f.start > 0) && !yearFlows.length) continue;
    const netFlows = yearFlows.reduce((a, r) => a + (r.type === 'deposit' ? +r.amount : -r.amount), 0);
    // 扣分成前：已结算的年份要把已转出的分成加回来
    const ytd = ok(f.start) ? f.value - f.start - netFlows + (f.feeKind === 'settled' ? f.fee : 0) : null;
    cards.push(`<div class="card person">
      <h3><span class="swatch" style="background:${v.color}"></span>${esc(v.name)}（出资人）${rateNote(v)}</h3>
      ${blockNote}
      <dl class="kv">
        <dt>持有份数</dt><dd>${units(f.units)}</dd>
        <dt>当前价值</dt><dd>${money(f.value)}</dd>
        <dt>占比</dt><dd>${pct(cur.share[v.id])}</dd>
        <dt>年初至今收益（扣分成前）</dt><dd>${signed(ytd)}</dd>
        <dt>期初价值</dt><dd>${money(f.start)}</dd>
        <dt>当前高水位</dt><dd>${money(f.H)}</dd>
        <dt>年末门槛线（不提成线）</dt><dd>${money(f.TYearEnd)}</dd>
        <dt>超出年末门槛线</dt><dd>${signed(ok(f.TYearEnd) ? (f.feeKind === 'settled' ? f.value + f.fee : f.value) - f.TYearEnd : null)}</dd>
        <dt>当前门槛线（按已过天数折算）</dt><dd>${money(f.T)}</dd>
        <dt>${feeLabel}分成</dt><dd>${money(f.fee)}</dd>
        <dt>到手收益</dt><dd>${signed(f.net)}</dd>
        <dt>到手收益率</dt><dd>${signed(f.netRate, pct)}</dd>
      </dl>
    </div>`);
  }
  const m = cur.me;
  const mNetFlows = flowsOf(res, cur.year, 'me').reduce((a, r) => a + (r.type === 'deposit' ? +r.amount : -r.amount), 0);
  const mYtd = ok(m.start) ? m.value - m.start - mNetFlows : null;
  cards.push(`<div class="card person">
      <h3><span class="swatch" style="background:var(--me)"></span>${esc(S.names.me)}（管理人）</h3>
      ${blockNote}
      <dl class="kv">
        <dt>持有份数</dt><dd>${units(m.units)}</dd>
        <dt>当前价值</dt><dd>${money(m.value)}</dd>
        <dt>占比</dt><dd>${pct(cur.share.me)}</dd>
        <dt>年初至今收益</dt><dd>${signed(blocked ? null : (m.feeKind === 'settled' ? mYtd : ok(mYtd) && ok(m.fee) ? mYtd + m.fee : null))}</dd>
        <dt>其中：投资收益</dt><dd>${signed(m.invGain)}</dd>
        <dt>投资收益率</dt><dd>${signed(m.invRate, pct)}</dd>
        <dt>其中：分成收入（${feeLabel}${invs.length > 1 ? '，所有出资人合计' : ''}）</dt><dd>${money(m.fee)}</dd>
        <dt>累计分成收入（已结算）</dt><dd>${money(cur.cumulativeFee)}</dd>
      </dl>
    </div>`);
  html.push(`<div class="grid people" style="margin-top:12px">${cards.join('')}</div>`);

  // 图表
  html.push(`<h2>走势</h2>
    <div class="card"><h3>账户净值</h3><div class="legend" id="lg-nav"></div><div class="chart" id="ch-nav"></div></div>
    <div class="card" style="margin-top:12px"><h3>每个人的价值</h3><div class="legend" id="lg-val"></div><div class="chart" id="ch-val"></div></div>`);

  // 季度明细
  const snaps = res.snapshots.filter((r) => !r.error);
  const valueCols = [ppl[ppl.length - 1], ...invs];
  html.push(`<h2>季度明细</h2><p class="small muted">有截图的行可点击查看截图。点表头可以排序。</p>
  <div class="table-wrap"><table id="tbl-snaps">
    <thead><tr><th>日期</th><th class="left">期间</th><th>账户总值</th><th>净值</th><th>相对上期</th><th>相对期初</th>${valueCols.map((p) => `<th>${esc(p.name)}价值</th>`).join('')}<th>分成${invs.length > 1 ? '（合计）' : ''}</th><th class="left">截图</th><th class="left">备注</th></tr></thead>
    <tbody>${snaps.length ? snaps.slice().reverse().map((r) => `
      <tr class="${r.shot ? 'clickable' : ''}" data-snap="${r.index}">
        <td>${esc(r.date)}</td><td class="left">${esc(r.period || '')}${r.settlement ? ' <span class="tag">年末结算</span>' : ''}</td>
        <td>${money(r.value)}</td><td>${navf(r.nav)}</td>
        <td>${signed(r.periodReturn, pct)}</td><td>${signed(r.ytdReturn, pct)}</td>
        ${valueCols.map((p) => `<td>${money(r.values[p.id])}</td>`).join('')}
        <td>${r.fee == null ? '—' : money(r.fee) + (r.feeKind === 'settled' ? '' : '<span class="muted small">（预估）</span>')}</td>
        <td class="left">${r.shot ? '<button class="link" type="button">查看</button>' : '<span class="muted">无</span>'}</td>
        <td class="note">${esc(r.note || '')}</td>
      </tr>`).join('') : `<tr><td colspan="${9 + valueCols.length}" class="left muted">暂无季度记录</td></tr>`}</tbody>
  </table></div>`);

  // 资金流动明细
  const flows = res.flows.filter((r) => !r.error);
  html.push(`<h2>资金流动明细</h2>
  <div class="table-wrap"><table id="tbl-flows">
    <thead><tr><th>日期</th><th class="left">谁</th><th class="left">类型</th><th>金额</th><th>当时总值</th><th>当时净值</th><th>买入/赎回份数</th><th class="left">备注</th></tr></thead>
    <tbody>${flows.length ? flows.slice().reverse().map((r) => `
      <tr><td>${esc(r.date)}</td><td class="left">${esc(nameOf(res, r.owner))}</td><td class="left">${typeName(r.type)}</td>
      <td>${money(+r.amount)}</td><td>${money(+r.valueBefore)}</td><td>${navf(r.nav)}</td>
      <td>${r.type === 'deposit' ? '+' : '−'}${units(r.units)}</td>
      <td class="note">${esc(r.note || '')}${r.hReset ? ' <span class="tag">份数归零，高水位清零</span>' : ''}</td></tr>`).join('') : '<tr><td colspan="8" class="left muted">暂无资金流动</td></tr>'}</tbody>
  </table></div>`);

  // 历年结算：每年每位出资人一行（当年与该出资人无关的不显示）
  const yearRows = [];
  for (const y of res.years.slice().reverse()) {
    const rows = invs.filter((v) => {
      const x = y.inv[v.id];
      return x.start > 0 || x.H0 > 0 || x.Vf > 0 || x.flowCount > 0;
    });
    if (!rows.length) {
      yearRows.push(`<tr><td>${y.year}</td><td class="left">—</td><td class="left">${yearStatus(y)}</td>${'<td>—</td>'.repeat(2)}<td class="left">无</td>${'<td>—</td>'.repeat(5)}</tr>`);
      continue;
    }
    for (const v of rows) {
      const x = y.inv[v.id];
      yearRows.push(`<tr><td>${y.year}</td><td class="left"><span class="swatch" style="background:${v.color};margin-right:6px"></span>${esc(v.name)}</td><td class="left">${yearStatus(y)}</td>
      <td>${money(x.start)}</td><td>${money(x.H0)}</td>
      <td class="left">${x.flowCount ? `注资 ${money(x.deposits)} / 提取 ${money(x.withdrawals)}${x.hReset ? '（曾归零）' : ''}` : '无'}</td>
      <td>${money(x.Vf)}</td><td>${money(x.T)}</td><td>${money(x.fee)}</td>
      <td>${units(x.transferUnits)}</td><td>${money(x.Hend)}</td></tr>`);
    }
  }
  html.push(`<h2>历年结算（出资人部分）</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>年份</th><th class="left">出资人</th><th class="left">状态</th><th>期初价值</th><th>期初高水位</th><th class="left">年内资金流动</th><th>年末价值</th><th>门槛线</th><th>当年分成</th><th>转移份数</th><th>年末高水位</th></tr></thead>
    <tbody>${yearRows.length ? yearRows.join('') : '<tr><td colspan="11" class="left muted">暂无</td></tr>'}</tbody>
  </table></div>
  <p class="small muted">“年末价值”为扣除分成前的价值。进行中的年份：年末价值、当年分成为截至最新记录的预估值；门槛线为按目前资金计算的年末门槛线。</p>`);

  html.push(rulesHtml(S, res.investors));
  root.innerHTML = html.join('');
  makeSortable(root.querySelector('#tbl-snaps'), 'view-snaps');
  makeSortable(root.querySelector('#tbl-flows'), 'view-flows');

  // 截图点击
  root.querySelectorAll('tr[data-snap]').forEach((tr) => {
    const r = snaps.find((x) => String(x.index) === tr.dataset.snap);
    if (r && r.shot && opts.onShot) tr.addEventListener('click', () => opts.onShot(r));
  });

  // 图表
  const colorOf = Object.fromEntries(ppl.map((p) => [p.id, p.color]));
  const start = { day: dayNum(data.inception.date), date: data.inception.date };
  const navPts = [{ x: start.day, date: start.date, y: 1 }, ...snaps.map((r) => ({ x: dayNum(r.date), date: r.date, y: r.nav }))];
  const markers = [];
  for (const r of flows) {
    markers.push({ x: dayNum(r.date), date: r.date, color: colorOf[r.owner] || 'var(--text-2)', shape: r.type === 'deposit' ? 'up' : 'down',
      label: `${nameOf(res, r.owner)}${typeName(r.type)} ${money(+r.amount)}` });
  }
  for (const y of res.years) {
    if (y.status === 'settled') markers.push({ x: dayNum(`${y.year}-12-31`), date: `${y.year}-12-31`, color: 'var(--text-2)', shape: 'diamond', label: `年末分成 ${money(y.fee)}（转移 ${units(y.transferUnits)} 份）` });
  }
  const swatches = ppl.map((p) => `<span style="color:${p.color}">■</span>${esc(p.name)}`).join(' ');
  const legendMarks = `<span><svg width="12" height="12"><path d="M6 1 L11 10 L1 10 Z" fill="var(--text-2)"/></svg>注资</span>
    <span><svg width="12" height="12"><path d="M6 11 L11 2 L1 2 Z" fill="var(--text-2)"/></svg>提取</span>
    <span><svg width="12" height="12"><path d="M6 1 L11 6 L6 11 L1 6 Z" fill="var(--text-2)"/></svg>年末分成转移</span>
    <span class="muted">（标记颜色：${swatches}）</span>`;
  root.querySelector('#lg-nav').innerHTML = `<span><span class="swatch" style="background:var(--accent)"></span>净值</span>${legendMarks}`;
  root.querySelector('#lg-val').innerHTML = ppl.map((p) => `<span><span class="swatch" style="background:${p.color}"></span>${esc(p.name)}</span>`).join('') + legendMarks;
  lineChart(root.querySelector('#ch-nav'), {
    series: [{ name: '净值', color: 'var(--accent)', points: navPts }], markers, yFmt: navf,
  });
  const initial = { me: +data.inception.me, ...Object.fromEntries(res.investors.map((v) => [v.id, v.initial])) };
  lineChart(root.querySelector('#ch-val'), {
    series: ppl.map((p) => ({
      name: p.name, color: p.color,
      points: [{ x: start.day, date: start.date, y: initial[p.id] }, ...snaps.map((r) => ({ x: dayNum(r.date), date: r.date, y: r.values[p.id] }))],
    })),
    markers, yFmt: shortMoney,
  });
}

function kpi(label, value, sub = '') {
  return `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function yearStatus(y) {
  if (y.status === 'settled') return '已结算';
  if (y.status === 'open') return `进行中（预估，截至 ${esc(y.asOf || '')}）`;
  if (y.status === 'unsettled') return '<span class="neg">无法结算：缺少 12 月 31 日快照</span>';
  if (y.status === 'blocked') return `<span class="neg">无法计算（因 ${y.blockedBy} 年未结算）</span>`;
  return esc(y.status);
}

function flowsOf(res, year, owner) {
  return res.flows.filter((r) => !r.error && r.owner === owner && +String(r.date).slice(0, 4) === year);
}

export function describeWhere(data, e) {
  if (e.where === 'inception') return '起始设置';
  if (e.where === 'investor') { const v = ((data && data.investors) || [])[e.index] || {}; return `出资人 ${v.name || ''}（第 ${e.index + 1} 位）`; }
  if (e.where === 'flow') { const f = (data.flows || [])[e.index] || {}; return `资金流动 ${f.date || ''}（第 ${e.index + 1} 条）`; }
  if (e.where === 'snapshot') { const s = (data.snapshots || [])[e.index] || {}; return `季度快照 ${s.date || ''}（第 ${e.index + 1} 条）`; }
  return e.where;
}

function shortMoney(x) {
  if (!ok(x)) return '—';
  if (Math.abs(x) >= 1e8) return nf2.format(x / 1e8) + '亿';
  if (Math.abs(x) >= 1e4) return (Math.round(x / 100) / 100).toLocaleString('zh-CN') + '万';
  return nf2.format(x);
}

export function rulesHtml(S, investors = []) {
  const h = pct(S.hurdle), s = pct(S.share);
  const me = esc(S.names.me);
  const custom = investors.filter((v) => v.custom && (v.custom.hurdle || v.custom.share));
  const customNote = custom.length
    ? `以下出资人单独设置了比例：${custom.map((v) => `${esc(v.name)}（门槛 ${pct(v.hurdle)}，分成 ${pct(v.share)}）`).join('、')}；其他人使用默认值。`
    : '所有出资人都使用这个默认值。';
  return `<h2>计算规则（通俗说明）</h2>
  <div class="card rules"><ol>
    <li><b>份额法。</b>账户被分成很多“份”，每份的价格叫“净值”。开户时净值为 1：${me}和每位出资人投入多少元就有多少份。之后 净值 = 账户总值 ÷ 总份数。每个人的钱 = 自己的份数 × 净值，所以大家按份数共同分享涨跌。</li>
    <li><b>注资和提取。</b>每次有人存钱或取钱，先记下这笔钱进出前一刻的账户总值，算出当时的净值，再用 金额 ÷ 净值 算出买入或卖出的份数。这样别人的份数和价值都不受影响。</li>
    <li><b>中途加入。</b>新的出资人随时可以加入：第一笔钱按当时的净值买入份数，和普通注资一样。加入那一年的门槛按这笔钱的在账天数折算。</li>
    <li><b>只有出资人的部分涉及分成，</b>${me}自己的钱不涉及门槛和分成。每位出资人<b>各自独立</b>计算门槛、高水位和分成，互不影响。按自然年结算，以 12 月 31 日的记录为准。</li>
    <li><b>门槛收益（默认 ${h}）。</b>${customNote}每年先保证出资人拿到门槛收益。门槛线 = 期初高水位 ×（1 + 门槛）+ 每笔年内注资 ×（1 + 门槛 × 在账天数 / 365）− 每笔年内提取 ×（1 + 门槛 × 剩余天数 / 365）。开户那年的首笔投入按全年门槛计算。页面上的“年末门槛线”就是不提成线：年末价值不超过它就没有分成，年内再有资金进出时它会相应变化；“当前门槛线”是按今天已过天数折算的版本，用来估算当前分成。</li>
    <li><b>分成（默认 ${s}）。</b>年末出资人的价值超过门槛线的部分，${me}按分成比例收取：分成 = max(0, 年末价值 − 门槛线) × 分成比例。超不过门槛线就没有分成。</li>
    <li><b>高水位线。</b>以前年份亏的钱要先补回来，补回之后的收益才算门槛和分成。高水位起点是出资人的首笔投入；年内注资就加上、提取就减去；年末取“调整后的高水位”和“扣除分成后的年末价值”中较大的那个，作为下一年的起点。如果某位出资人的份数全部取完归零，他的高水位清零，再投入时重新开始。</li>
    <li><b>分成不取出。</b>年末把分成对应的份数（分成 ÷ 年末净值）从出资人名下转到${me}名下，钱留在账户里继续投资，净值和账户总值都不变。</li>
    <li><b>季度预估。</b>年中每次季度记录都会按同样的公式估算“如果今天结算，分成是多少”，门槛按 1 月 1 日起已过的天数折算；但开户那一年，开户时首笔投入的门槛始终按全年满额计算，不折算。预估只供参考，不转移份数。</li>
    <li><b>提取限制。</b>任何人提取都不能超过自己当时的价值；出资人提取时还要留够自己当时的预估分成。</li>
    <li><b>缺少年末记录。</b>如果某年没有 12 月 31 日的记录，该年无法结算，之后年份的门槛、高水位和分成也无法计算，页面会明确提示，不做估算。</li>
    <li><b>收益率。</b>相对上期 = 本期净值 ÷ 上期净值 − 1；相对期初 = 当前净值 ÷ 当年年初净值 − 1。出资人的到手收益 = 当前价值 − 分成 − 期初价值 − 年内净注资；到手收益率 = 到手收益 ÷（期初价值 + 年内每笔注资/提取按在账时间比例折算后的金额）。</li>
  </ol></div>`;
}

// ───── 内联 SVG 折线图 ─────
export function lineChart(el, opts) {
  drawChart(el, opts);
  // 按容器实际宽度绘制，手机上文字不会被缩小
  if (typeof ResizeObserver !== 'undefined' && !el._ro) {
    let lastW = el.clientWidth;
    el._ro = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - lastW) > 4) { lastW = el.clientWidth; drawChart(el, opts); }
    });
    el._ro.observe(el);
  }
}

function drawChart(el, { series, markers = [], yFmt = (v) => String(v) }) {
  const W = Math.max(300, el.clientWidth || 800), H = W < 500 ? 220 : 260;
  const padL = 64, padR = 12, padT = 12, padB = 46;
  const all = series.flatMap((s) => s.points).filter((p) => ok(p.y));
  if (all.length < 1) { el.innerHTML = '<p class="muted small">暂无数据</p>'; return; }
  let x0 = Math.min(...all.map((p) => p.x), ...markers.map((m) => m.x));
  let x1 = Math.max(...all.map((p) => p.x), ...markers.map((m) => m.x));
  if (x1 - x0 < 30) { x0 -= 15; x1 += 15; }
  let y0 = Math.min(...all.map((p) => p.y)), y1 = Math.max(...all.map((p) => p.y));
  if (y1 - y0 < 1e-9) { const d = Math.abs(y1) * 0.05 || 1; y0 -= d; y1 += d; }
  const ticks = niceTicks(y0, y1, 5);
  y0 = Math.min(y0, ticks[0]); y1 = Math.max(y1, ticks[ticks.length - 1]);
  const sx = (x) => padL + (x - x0) / (x1 - x0) * (W - padL - padR);
  const sy = (y) => padT + (1 - (y - y0) / (y1 - y0)) * (H - padT - padB);
  const baseY = H - padB;
  const parts = [];
  parts.push(`<g class="axis">${ticks.map((t) => `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${padL - 6}" y="${sy(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`).join('')}</g>`);
  // x 轴：年份刻度
  const yStart = new Date(x0 * 864e5).getUTCFullYear(), yEnd = new Date(x1 * 864e5).getUTCFullYear();
  const xt = [];
  for (let y = yStart; y <= yEnd + 1; y++) {
    for (const mo of [1, 4, 7, 10]) {
      const d = Date.UTC(y, mo - 1, 1) / 864e5;
      if (d >= x0 && d <= x1) xt.push({ d, label: mo === 1 ? `${y}` : `${mo}月`, major: mo === 1 });
    }
  }
  const showMinor = xt.length <= Math.floor(W / 70);
  parts.push(`<g class="axis">${xt.filter((t) => t.major || showMinor).map((t) => `<line class="gridline" x1="${sx(t.d)}" x2="${sx(t.d)}" y1="${padT}" y2="${baseY}" ${t.major ? '' : 'stroke-dasharray="2 3"'}/><text x="${sx(t.d)}" y="${baseY + 16}" text-anchor="middle">${t.label}</text>`).join('')}</g>`);
  for (const s of series) {
    const pts = s.points.filter((p) => ok(p.y));
    if (pts.length > 1) parts.push(`<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    for (const p of pts) parts.push(`<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="3" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`);
  }
  // 标记：资金流动 / 年末分成，画在横轴下方
  const my = baseY + 30;
  for (const m of markers) {
    const x = sx(m.x);
    const path = m.shape === 'up' ? `M${x} ${my - 6} L${x + 6} ${my + 5} L${x - 6} ${my + 5} Z`
      : m.shape === 'down' ? `M${x} ${my + 6} L${x + 6} ${my - 5} L${x - 6} ${my - 5} Z`
        : `M${x} ${my - 6} L${x + 6} ${my} L${x} ${my + 6} L${x - 6} ${my} Z`;
    parts.push(`<path d="${path}" fill="${m.color}" stroke="var(--surface)" stroke-width="1.5"/>`);
  }
  parts.push(`<line class="hover-line" x1="0" x2="0" y1="${padT}" y2="${baseY}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>`);
  parts.push(`<rect class="hit" x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent"/>`);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="折线图">${parts.join('')}</svg><div class="tip hidden"></div>`;

  // 悬停 / 触摸：显示最近日期的数值
  const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), line = el.querySelector('.hover-line');
  const xs = [...new Set([...all.map((p) => p.x), ...markers.map((m) => m.x)])].sort((a, b) => a - b);
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const vx = (ev.clientX - r.left) / r.width * W;
    const xv = x0 + (vx - padL) / (W - padL - padR) * (x1 - x0);
    let best = xs[0];
    for (const x of xs) if (Math.abs(x - xv) < Math.abs(best - xv)) best = x;
    const date = new Date(best * 864e5).toISOString().slice(0, 10);
    const rows = [`<b>${date}</b>`];
    for (const s of series) {
      const p = s.points.find((q) => q.x === best);
      if (p && ok(p.y)) rows.push(`<span style="color:${s.color}">●</span> ${esc(s.name)}：${esc(yFmt === shortMoney ? money(p.y) : yFmt(p.y))}`);
    }
    for (const m of markers.filter((q) => q.x === best)) rows.push(`<span style="color:${m.color}">◆</span> ${esc(m.label)}`);
    tip.innerHTML = rows.join('<br>');
    tip.classList.remove('hidden');
    const px = sx(best) / W * r.width;
    line.setAttribute('x1', sx(best)); line.setAttribute('x2', sx(best)); line.setAttribute('visibility', 'visible');
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(r.width - tw, px + 12 + tw > r.width ? px - tw - 12 : px + 12)) + 'px';
    tip.style.top = '8px';
  };
  const leave = () => { tip.classList.add('hidden'); line.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
}

function niceTicks(a, b, n) {
  const span = b - a;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.floor(a / step) * step; v <= b + step * 0.5; v += step) out.push(+v.toPrecision(12));
  return out.length >= 2 ? out : [a, b];
}

export { isYearEnd };
