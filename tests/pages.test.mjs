// 页面文件的一致性检查（不需要浏览器）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8');
const pages = ['index.html', 'editor.html'];
const localModules = fs.readdirSync(root).filter((f) => f.endsWith('.js'));

test('两个页面使用同一个版本号，并为所有本地模块和样式表加上版本号', () => {
  const versions = new Set();
  for (const p of pages) {
    const html = read(p);
    const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports;
    for (const m of localModules) {
      const v = /\?v=(.+)$/.exec(map[`./${m}`] || '');
      assert.ok(v, `${p} 的 importmap 缺少 ${m}`);
      versions.add(v[1]);
    }
    const css = /href="style\.css\?v=([^"]+)"/.exec(html);
    assert.ok(css, `${p} 的样式表没有版本号`);
    versions.add(css[1]);
  }
  assert.equal(versions.size, 1, `版本号不一致：${[...versions].join(', ')}`);
});

test('所有表单都不会因脚本加载失败而以网址参数提交（防止密码进入网址）', () => {
  for (const p of pages) {
    for (const form of read(p).match(/<form[^>]*>/g)) {
      assert.match(form, /method="post"/, `${p}: ${form}`);
      assert.match(form, /onsubmit="return false"/, `${p}: ${form}`);
    }
  }
});

test('模块之间只用相对路径导入本地文件（这样 importmap 才能生效）', () => {
  for (const f of [...localModules, ...pages]) {
    for (const [, spec] of read(f).matchAll(/from\s+'([^']+)'/g)) {
      assert.match(spec, /^\.\/[a-z]+\.js$/, `${f} 导入了 ${spec}`);
    }
  }
});
