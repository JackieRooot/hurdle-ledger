// github.js —— 编辑页直接把加密文件提交到 GitHub 仓库（REST API，浏览器端 CORS 可用）。
// 需要一个只授权本仓库、权限为 Contents: Read and write 的 fine-grained token。
// token 只保存在你自己的浏览器里（用数据密码加密后放在 localStorage），绝不进入仓库。
// 一次发布 = 一个提交（Git Data API：blob → tree → commit → 更新分支）。

const API = 'https://api.github.com';

export function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64) {
  const s = atob(b64.replace(/\s/g, ''));
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

// git 的 blob sha：sha1("blob <长度>\0" + 内容)。用来判断仓库里的文件是否被别处改过。
export async function gitBlobSha(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head, 0); all.set(bytes, head.length);
  const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', all));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 从 GitHub Pages 网址推断仓库：<owner>.github.io/<repo>/
export function detectRepo(loc = globalThis.location) {
  if (!loc) return { owner: '', repo: '' };
  const m = /^([^.]+)\.github\.io$/i.exec(loc.hostname || '');
  const seg = (loc.pathname || '').split('/').filter(Boolean);
  if (!m) return { owner: '', repo: '' };
  const repo = seg.length && !/\.html?$/i.test(seg[0]) ? seg[0] : `${m[1]}.github.io`;
  return { owner: m[1], repo };
}

export class GitHubError extends Error {
  constructor(msg, status) { super(msg); this.name = 'GitHubError'; this.status = status; }
}

export class GitHubRepo {
  constructor({ owner, repo, branch = 'main', token, fetchImpl }) {
    Object.assign(this, { owner, repo, branch, token });
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  async req(method, path, body, accept = 'application/vnd.github+json') {
    const r = await this.fetch(`${API}/repos/${this.owner}/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json()).message || ''; } catch { /* 忽略 */ }
      const hint = r.status === 401 ? 'token 无效或已过期'
        : r.status === 403 ? 'token 没有写入权限，或触发了频率限制'
          : r.status === 404 ? '找不到仓库/分支/文件，或 token 没有授权这个仓库'
            : r.status === 409 || r.status === 422 ? '仓库在此期间被修改，请重试' : '';
      throw new GitHubError(`GitHub 请求失败（HTTP ${r.status}${hint ? '，' + hint : ''}）${detail ? '：' + detail : ''}`, r.status);
    }
    return accept.includes('raw') ? new Uint8Array(await r.arrayBuffer()) : r.json();
  }

  // 检查 token 和仓库是否可用
  async check() {
    const info = await this.req('GET', '');
    if (info.permissions && !info.permissions.push) throw new GitHubError('这个 token 对仓库没有写入权限。');
    return info;
  }

  async headCommit() {
    const ref = await this.req('GET', `/git/ref/heads/${encodeURIComponent(this.branch)}`);
    const commit = await this.req('GET', `/git/commits/${ref.object.sha}`);
    return { sha: ref.object.sha, tree: commit.tree.sha };
  }

  // 读取分支上的文件（不受 Pages 部署延迟影响）。不存在时返回 null。
  async readFile(path) {
    try {
      return await this.req('GET', `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`, null, 'application/vnd.github.raw+json');
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // 当前分支上某个文件的 blob sha（不存在为 null）
  async fileSha(path, treeSha) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const name = path.slice(path.lastIndexOf('/') + 1);
    let t = await this.req('GET', `/git/trees/${treeSha}`);
    if (dir) {
      for (const part of dir.split('/')) {
        const e = t.tree.find((x) => x.path === part && x.type === 'tree');
        if (!e) return null;
        t = await this.req('GET', `/git/trees/${e.sha}`);
      }
    }
    const e = t.tree.find((x) => x.path === name && x.type === 'blob');
    return e ? e.sha : null;
  }

  /**
   * 一次提交多个文件。
   * @param files   [{ path, bytes }]
   * @param deletes [path]
   * @param expect  { path, sha }：提交前确认该文件仍是这个版本（防止覆盖别处的修改）；sha 为 null 表示应当不存在
   */
  async commit({ files = [], deletes = [], message, expect }) {
    const head = await this.headCommit();
    if (expect) {
      const cur = await this.fileSha(expect.path, head.tree);
      if (cur !== expect.sha) {
        throw new GitHubError('仓库中的 data.enc 已经被别处修改过（例如在另一台设备上发布过）。为避免覆盖，请重新加载最新数据后再修改。', 409);
      }
    }
    const tree = [];
    for (const f of files) {
      const blob = await this.req('POST', '/git/blobs', { content: bytesToBase64(f.bytes), encoding: 'base64' });
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    for (const p of deletes) {
      if (files.some((f) => f.path === p)) continue;
      if (await this.fileSha(p, head.tree)) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
    }
    const newTree = await this.req('POST', '/git/trees', { base_tree: head.tree, tree });
    const commit = await this.req('POST', '/git/commits', { message, tree: newTree.sha, parents: [head.sha] });
    await this.req('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: commit.sha, force: false });
    return commit.sha;
  }
}
