// github.js 测试：用模拟的 GitHub API，不访问网络
import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubRepo, gitBlobSha, detectRepo, bytesToBase64, base64ToBytes } from '../github.js';

test('git blob sha 与 git 一致', async () => {
  assert.equal(await gitBlobSha(new Uint8Array()), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(await gitBlobSha(new TextEncoder().encode('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('base64 往返', () => {
  const u = new Uint8Array(70000).map((_, i) => (i * 7) % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(u)), u);
});

test('从 Pages 网址推断仓库', () => {
  assert.deepEqual(detectRepo({ hostname: 'alice.github.io', pathname: '/hurdle-ledger/editor.html' }), { owner: 'alice', repo: 'hurdle-ledger' });
  assert.deepEqual(detectRepo({ hostname: 'localhost', pathname: '/' }), { owner: '', repo: '' });
});

// 极简的内存 GitHub 模拟
function fakeGitHub(files) {
  const blobs = new Map(), trees = new Map(), commits = new Map();
  let n = 0;
  const id = () => (++n).toString(16).padStart(40, '0');
  const mkTree = (map) => {
    // map: path → blobSha（支持一级目录）
    const root = [], dirs = {};
    for (const [p, sha] of map) {
      if (p.includes('/')) { const [d, f] = p.split('/'); (dirs[d] ||= []).push({ path: f, type: 'blob', sha }); }
      else root.push({ path: p, type: 'blob', sha });
    }
    for (const [d, entries] of Object.entries(dirs)) { const s = id(); trees.set(s, { tree: entries }); root.push({ path: d, type: 'tree', sha: s }); }
    const s = id(); trees.set(s, { tree: root, flat: map }); return s;
  };
  const init = new Map();
  for (const [p, b] of Object.entries(files)) { const s = id(); blobs.set(s, b); init.set(p, s); }
  let head = id(); commits.set(head, { tree: { sha: mkTree(init) } });
  const calls = [];
  const fetchImpl = async (url, opt) => {
    const path = url.replace('https://api.github.com/repos/o/r', '');
    const body = opt.body ? JSON.parse(opt.body) : null;
    calls.push(`${opt.method} ${path}`);
    assert.equal(opt.headers.Authorization, 'Bearer T');
    const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o, arrayBuffer: async () => o });
    if (path === '') return json({ permissions: { push: true } });
    if (path === '/git/ref/heads/main') return json({ object: { sha: head } });
    if (path.startsWith('/git/commits/')) return json(commits.get(path.slice(13)));
    if (path.startsWith('/git/trees/')) return json(trees.get(path.slice(11)));
    if (path === '/git/blobs') { const s = id(); blobs.set(s, base64ToBytes(body.content)); return json({ sha: s }); }
    if (path === '/git/trees') {
      const flat = new Map(trees.get(body.base_tree).flat);
      for (const e of body.tree) { if (e.sha === null) flat.delete(e.path); else flat.set(e.path, e.sha); }
      return json({ sha: mkTree(flat) });
    }
    if (path === '/git/commits') { const s = id(); commits.set(s, { tree: { sha: body.tree }, parents: body.parents, message: body.message }); return json({ sha: s }); }
    if (path === '/git/refs/heads/main') { head = body.sha; return json({}); }
    if (path.startsWith('/contents/')) {
      const p = decodeURIComponent(path.slice(10).split('?')[0]);
      const flat = trees.get(commits.get(head).tree.sha).flat;
      return flat.has(p) ? json(blobs.get(flat.get(p)).buffer) : json({ message: 'Not Found' }, 404);
    }
    throw new Error('unexpected ' + path);
  };
  return { fetchImpl, calls, read: (p) => { const f = trees.get(commits.get(head).tree.sha).flat; return f.has(p) ? blobs.get(f.get(p)) : null; }, head: () => commits.get(head) };
}

test('一次提交写入多个文件并删除旧截图', async () => {
  const oldData = new Uint8Array([1, 2, 3]);
  const gh = fakeGitHub({ 'data.enc': oldData, 'shots/old.enc': new Uint8Array([9]), 'index.html': new Uint8Array([7]) });
  const repo = new GitHubRepo({ owner: 'o', repo: 'r', token: 'T', fetchImpl: gh.fetchImpl });
  await repo.check();
  const newData = new Uint8Array([4, 5, 6]);
  await repo.commit({
    files: [{ path: 'data.enc', bytes: newData }, { path: 'shots/2026Q3.enc', bytes: new Uint8Array([8]) }],
    deletes: ['shots/old.enc'],
    message: 'Update encrypted ledger data',
    expect: { path: 'data.enc', sha: 'f'.repeat(40) },
  }).then(() => assert.fail('应当因版本不符被拒绝'), (e) => assert.equal(e.status, 409));
  // 模拟服务器的 id 不是真实的 git sha，这里直接取当前 sha
  const cur = await repo.fileSha('data.enc', (await repo.headCommit()).tree);
  await repo.commit({
    files: [{ path: 'data.enc', bytes: newData }, { path: 'shots/2026Q3.enc', bytes: new Uint8Array([8]) }],
    deletes: ['shots/old.enc'],
    message: 'Update encrypted ledger data',
    expect: { path: 'data.enc', sha: cur },
  });
  assert.deepEqual(gh.read('data.enc'), newData);
  assert.deepEqual(gh.read('shots/2026Q3.enc'), new Uint8Array([8]));
  assert.equal(gh.read('shots/old.enc'), null);
  assert.deepEqual(gh.read('index.html'), new Uint8Array([7]));
  assert.equal(gh.head().message, 'Update encrypted ledger data');
  assert.deepEqual(new Uint8Array(await repo.readFile('data.enc')), newData);
  assert.equal(await repo.readFile('nope.enc'), null);
});

test('新建数据集时仓库里已有 data.enc 会被拒绝', async () => {
  const gh = fakeGitHub({ 'data.enc': new Uint8Array([1]) });
  const repo = new GitHubRepo({ owner: 'o', repo: 'r', token: 'T', fetchImpl: gh.fetchImpl });
  await assert.rejects(repo.commit({ files: [{ path: 'data.enc', bytes: new Uint8Array([2]) }], message: 'm', expect: { path: 'data.enc', sha: null } }), /被别处修改/);
  assert.deepEqual(gh.read('data.enc'), new Uint8Array([1]));
});

test('从本地文件加载后首次发布：仓库里还没有 data.enc 时允许', async () => {
  const gh = fakeGitHub({ 'index.html': new Uint8Array([7]) });
  const repo = new GitHubRepo({ owner: 'o', repo: 'r', token: 'T', fetchImpl: gh.fetchImpl });
  await repo.commit({ files: [{ path: 'data.enc', bytes: new Uint8Array([5]) }], message: 'm', expect: { path: 'data.enc', sha: ['f'.repeat(40), null] } });
  assert.deepEqual(gh.read('data.enc'), new Uint8Array([5]));
  // 仓库里已有另一个版本时仍然拒绝
  await assert.rejects(repo.commit({ files: [{ path: 'data.enc', bytes: new Uint8Array([6]) }], message: 'm', expect: { path: 'data.enc', sha: ['f'.repeat(40), null] } }), /被别处修改/);
});
