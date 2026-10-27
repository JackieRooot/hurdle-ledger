// ocr.js —— 从券商 App 的资产截图里读出总资产，用于自动填写快照的“账户总值”。
// 识别完全在浏览器本地进行（Tesseract.js，见 vendor/），截图不会离开本机。
//
// 两轮识别：
//   1. 中文模型识别整张图，只用来找“总资产 / 股票 / 理财 / 现金”等标签，以及紧挨着它们的数字在哪里；
//   2. 把这些数字逐个裁出来放大，用英文模型、只允许 0-9 , . + - 再读一次
//      （小字号的数字在第一轮里常把逗号、小数点读错）。
// 最后核对“各分项之和 = 总资产”；核对不上时换一个缩放比例再找一次分项。
// 截图里常见的干扰：同一行右边的“昨日收益 +11,700.00”、打码的账号、日期、百分比——
// 只取标签正下方（或同一行右边）且不带正负号、百分号的金额。
// 除 recognizeAssets 以外都是纯函数，不依赖浏览器，供测试使用。

const VENDOR = './vendor/tesseract-5.1.1/';
// 第一轮识别前把截图缩到这个宽度以内。识别结果对缩放比例比较敏感：分项核对不上时换下一个宽度再找一次
const PAGE_WIDTHS = [1000, 800];
const DIGIT_HEIGHT = 150;  // 第二轮把每个数字放大到大约这个高度（像素）

const TOTAL_LABELS = ['总资产', '资产总值', '资产总额', '账户总值', '资产(元)'];
const PART_LABELS = ['股票', '基金', '债券', '理财', '现金'];

// 全角 → 半角，各种横线 → '-'，去掉空白（中文识别结果里字与字之间常有空格）
const norm = (s) => String(s)
  .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[—–−]/g, '-')
  .replace(/\s+/g, '');

/** 截图上的金额文字 → 数值；不是“两位小数的金额”（带正负号、百分比、日期、打码等）时返回 null */
export function parseAmount(text) {
  const s = norm(text).replace(/^(?:HK\$|US\$|[¥￥$])/, '').replace(/元$/, '');
  // 千分位可能被读成小数点（174.780.00），所以只把最后的“分隔符 + 两位数字”当作小数部分
  if (!/^\d{1,3}(?:[.,]\d{3})*[.,]\d{2}$/.test(s) && !/^\d+[.,]\d{2}$/.test(s)) return null;
  return (+s.slice(0, -3).replace(/[.,]/g, '') * 100 + +s.slice(-2)) / 100;
}

const cents = (v) => Math.round(v * 100);
const height = (b) => b.y1 - b.y0;
const union = (bs) => ({
  x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)),
  x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)),
});
const overlapX = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
const sameRow = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) >= 0.5 * Math.min(height(a), height(b));
const hasDigits = (t) => /\d|\*{3}/.test(t);
const isSigned = (t) => /^[-+]|%/.test(t);
const isMasked = (t) => t.includes('*');
const isCJK = (c) => /[一-鿿]/.test(c || '');

/** Tesseract 的识别结果（recognize(..., { blocks: true })）→ [{ words: [{ text, bbox }] }]，坐标乘以 scale */
export function linesOf(data, scale = 1) {
  const s = (b) => ({ x0: b.x0 * scale, y0: b.y0 * scale, x1: b.x1 * scale, y1: b.y1 * scale });
  const lines = [];
  for (const block of data.blocks || []) for (const para of block.paragraphs) for (const line of para.lines) {
    lines.push({ words: line.words.map((w) => ({ text: w.text, bbox: s(w.bbox) })) });
  }
  return lines;
}

// 一行里挨在一起的词合并成一段，含数字的段就是候选金额（只需要位置，数字由第二轮重新读）。
// 第一轮常把一个金额拆开，甚至把其中几位读成汉字（如 174,780.00 → “1” “列” “78000”），
// 所以单个字也并进来，只在两个字以上的文字（如标签）或分隔线处断开。
function numberClusters(line) {
  const out = [];
  let cur = null;
  for (const w of [...line.words].sort((a, b) => a.bbox.x0 - b.bbox.x0)) {
    const t = norm(w.text);
    if (t === '|' || !(hasDigits(t) || t.length <= 1)) { cur = null; continue; }
    if (cur && w.bbox.x0 - cur.bbox.x1 <= 0.8 * Math.max(height(cur.bbox), height(w.bbox))) {
      cur.text += t; cur.bbox = union([cur.bbox, w.bbox]);
    } else out.push(cur = { text: t, bbox: { ...w.bbox } });
  }
  return out.filter((c) => hasDigits(c.text));
}

// 在一行里找标签（按字拼起来找，再换回对应的词的位置）
function findLabel(line, label) {
  let joined = '';
  const owner = [];
  for (const w of line.words) {
    const t = norm(w.text);
    joined += t;
    for (let i = 0; i < t.length; i++) owner.push(w);
  }
  const hits = [];
  for (let i = joined.indexOf(label); i >= 0; i = joined.indexOf(label, i + 1)) {
    hits.push({ bbox: union(owner.slice(i, i + label.length).map((w) => w.bbox)), before: joined[i - 1] });
  }
  return hits;
}

/**
 * 第一轮：找出总资产和各分项的数字位置。
 * @returns { total: { text, bbox } | null, parts: [{ label, text, bbox }], hidden, clearing }
 *   text 是第一轮读到的文字，bbox 用于第二轮裁剪；hidden = 金额被 App 隐藏成 ****；clearing = 截图处于清算时间
 */
export function locateAssets(lines) {
  const clusters = lines.flatMap(numberClusters);
  const clearing = lines.some((l) => l.words.map((w) => norm(w.text)).join('').includes('清算'));
  let total = null, anchor = null, hidden = false;
  search: for (const label of TOTAL_LABELS) {
    for (const line of lines) {
      for (const hit of findLabel(line, label)) {
        const h = height(hit.bbox);
        // 金额在标签正下方（左右有重叠）或同一行右边；取最近的一个
        let best = null, bestD = Infinity;
        for (const c of clusters) {
          let d;
          if (sameRow(c.bbox, hit.bbox) && c.bbox.x0 >= hit.bbox.x1 - 0.2 * h) d = (c.bbox.x0 - hit.bbox.x1) / h;
          else if (c.bbox.y0 >= hit.bbox.y1 - 0.3 * h && c.bbox.y0 - hit.bbox.y1 <= 3 * h && overlapX(c.bbox, hit.bbox) > 0) d = (c.bbox.y0 - hit.bbox.y1) / h;
          else continue;
          if (isSigned(c.text)) continue;
          if (d < bestD) { best = c; bestD = d; }
        }
        if (!best) continue;
        anchor = hit.bbox;
        if (isMasked(best.text)) hidden = true; else total = best;
        break search;
      }
    }
  }
  const parts = [];
  for (const label of PART_LABELS) {
    for (const line of lines) {
      // 分项在总资产下方；标签前面不能紧挨着别的汉字（“可用资金”“我的理财”之类不算）
      const hit = findLabel(line, label).find((x) => !isCJK(x.before) && (!anchor || x.bbox.y0 > anchor.y1));
      if (!hit) continue;
      const h = height(hit.bbox);
      const c = clusters
        .filter((c) => c !== total && sameRow(c.bbox, hit.bbox) && c.bbox.x0 >= hit.bbox.x1 - 0.2 * h)
        .sort((a, b) => a.bbox.x0 - b.bbox.x0)[0];
      if (c && !isSigned(c.text) && !isMasked(c.text)) { parts.push({ label, text: c.text, bbox: c.bbox }); break; }
    }
  }
  return { total, parts, hidden, clearing };
}

/** 合并两次第一轮的结果（坐标都已换算到原图）：总资产以先找到的为准，补上之前漏掉的分项 */
export function mergeFound(a, b) {
  const parts = [...a.parts, ...b.parts.filter((p) => !a.parts.some((q) => q.label === p.label))];
  return {
    total: a.total || b.total,
    parts: parts.sort((x, y) => PART_LABELS.indexOf(x.label) - PART_LABELS.indexOf(y.label)),
    hidden: !(a.total || b.total) && (a.hidden || b.hidden),
    clearing: a.clearing || b.clearing,
  };
}

/**
 * 汇总两轮的读数（每项的 reread 是第二轮读到的文字）。
 * @returns { value, check: 'ok' | 'mismatch' | 'none', parts: [{ label, value }], partsSum, warnings, error }
 *   ok = 与分项之和一致；mismatch = 不一致；none = 分项不足，无法核对；error 非空时 value 为 null
 *   没找到总资产时不用分项之和代替：漏掉一个分项就会填入错误的金额
 */
export function settleAssets(found) {
  const warnings = found.clearing ? ['截图处于清算时间，券商提示资产统计可能有误差。'] : [];
  // 每项的候选读数：第二轮优先，第一轮兜底
  const options = (it) => [...new Set([parseAmount(it.reread ?? ''), parseAmount(it.text)].filter((v) => v != null))];
  const parts = found.parts.map((p) => ({ label: p.label, options: options(p) })).filter((p) => p.options.length);
  const totals = found.total ? options(found.total) : [];
  const sumOf = (picks) => parts.reduce((s, p, i) => s + cents(p.options[picks[i]]), 0);
  const result = (value, check, picks, error = '') => ({
    value, check, warnings, error,
    parts: parts.map((p, i) => ({ label: p.label, value: p.options[picks[i]] })),
    partsSum: parts.length ? sumOf(picks) / 100 : null,
  });
  const first = parts.map(() => 0);
  if (!totals.length) {
    if (found.hidden) return result(null, 'none', first, '截图里的金额被隐藏了（****），请在 App 里显示金额后重新截图。');
    return result(null, 'none', first, '没能在截图里找到总资产，请手动填写。');
  }
  // 在两轮读数的各种组合里找“分项之和 = 总资产”的一组；多组时尽量用第二轮的读数
  let best = null;
  const walk = (i, picks) => {
    if (i < parts.length) { parts[i].options.forEach((_, k) => walk(i + 1, [...picks, k])); return; }
    const sum = sumOf(picks);
    totals.forEach((t, k) => {
      const score = k + picks.reduce((s, x) => s + x, 0);
      if (cents(t) === sum && (!best || score < best.score)) best = { score, total: t, picks };
    });
  };
  if (parts.length) walk(0, []);
  if (best) return result(best.total, 'ok', best.picks);
  return result(totals[0], parts.length >= 2 ? 'mismatch' : 'none', first);
}

// ───── 以下只在浏览器中使用 ─────

let engine = null;
function getEngine() {
  engine = engine || (async () => {
    const { default: Tesseract } = await import(VENDOR + 'tesseract.esm.min.js');
    const base = new URL(VENDOR, import.meta.url).href;
    const opts = { workerPath: base + 'worker.min.js', corePath: base, langPath: base + 'lang', cacheMethod: 'none' };
    const [page, digits] = await Promise.all([Tesseract.createWorker('chi_sim', 1, opts), Tesseract.createWorker('eng', 1, opts)]);
    await digits.setParameters({ tessedit_char_whitelist: '0123456789.,+-', tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE });
    return { page, digits };
  })().catch((err) => { engine = null; throw err; });
  return engine;
}

async function loadBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('无法读取这张图片'));
        img.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
  }
}

// 第二轮用的小图：裁出数字（四周略留一点），放大，加白边，转灰度并加强对比
function digitCanvas(src, b) {
  const h = height(b), pad = 0.25 * h;
  const sx = Math.max(0, b.x0 - pad), sy = Math.max(0, b.y0 - pad);
  const sw = Math.min(src.width, b.x1 + pad) - sx, sh = Math.min(src.height, b.y1 + pad) - sy;
  const k = Math.min(4, Math.max(1, DIGIT_HEIGHT / h)), margin = Math.round(0.5 * h * k);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * k) + 2 * margin; canvas.height = Math.round(sh * k) + 2 * margin;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, margin, margin, Math.round(sw * k), Math.round(sh * k));
  return enhance(canvas);
}

// 转灰度并加强对比（浅灰色的标签文字、彩色的数字都会更清楚）
function enhance(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height), px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = px[i + 1] = px[i + 2] = Math.max(0, Math.min(255, (g - 128) * 2.3 + 128));
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

let queue = Promise.resolve();
/**
 * 识别截图里的总资产。同一时间只跑一个识别，后来的排队。
 * @param opts.onStatus(text) 进度提示；opts.stale() 返回 true 时放弃（例如又选了另一张图），结果为 null
 * @returns settleAssets 的结果，或 null
 */
export function recognizeAssets(file, { onStatus = () => {}, stale = () => false } = {}) {
  const run = async () => {
    if (stale()) return null;
    onStatus('正在加载识别组件（第一次需下载约 12 MB，之后会快很多）……');
    const { page, digits } = await getEngine();
    if (stale()) return null;
    onStatus('正在识别截图……');
    const src = await loadBitmap(file);
    const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
    let found = null, result = null;
    for (const width of PAGE_WIDTHS) {
      const k = Math.min(1, width / w);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      const { data } = await page.recognize(enhance(canvas), {}, { blocks: true });
      const more = locateAssets(linesOf(data, 1 / k));
      found = found ? mergeFound(found, more) : more;
      for (const item of [found.total, ...found.parts]) {
        if (!item || item.reread != null) continue;
        if (stale()) return null;
        item.reread = (await digits.recognize(digitCanvas(src, item.bbox))).data.text;
      }
      result = settleAssets(found);
      if (result.check === 'ok' || stale()) break;
      onStatus('分项没有核对上，正在换一个比例再找一次……');
    }
    return stale() ? null : result;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}
