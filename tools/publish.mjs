// tools/publish.mjs — 通过 GitHub REST API 发布这个静态站点到 GitHub Pages
// 用法:  node tools/publish.mjs
//
// 为什么要用 API 而不是 git：这台机器上没装 git / gh。
// GitHub 的 Contents API 可以直接提交文件，效果与 push 等价。
//
// Token 来源（按优先级）：
//   1) 环境变量 GH_TOKEN
//   2) 工作区里的 _token.txt（仅本地使用，绝不要提交进仓库）
//
// 本机不装 git 也能发布，但代价是需要一个有效 token；脚本不会打印 token 本身。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import https from 'node:https';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ---------- 配置 ---------- */
const OWNER  = process.env.GH_OWNER  || 'Nine-Crane';
const REPO   = process.env.GH_REPO   || 'jungle-coach';
const BRANCH = process.env.GH_BRANCH || 'main';
const DESC   = '用回合制决策模拟器训练《王者荣耀》打野的 Gank / 刷野 / 入侵 / 拿龙 判断力，赛后给决策复盘报告。';

// 要发布的文件（仓库根目录相对路径）。刻意只发布必要的文件，
// 避免把工作区里的 token / 临时文件带上线。
const FILES = [
  'index.html',
  'README.md',
  'LICENSE',
  '.gitignore',
  'tools/sim.mjs',
  'tools/check.mjs',
  'tools/publish.mjs'
];

/* ---------- token ---------- */
// token 文件有两个坑：
//   1) 可能是 UTF-16LE（Windows 记事本另存为常见结果，带 FF FE BOM）。
//      按 UTF-8 读会得到交错的 \0 字节，长度翻倍且全是非法字符，
//      现象是 Authorization header 直接抛 ERR_INVALID_CHAR。
//   2) 常带首尾换行、零宽字符。
// 所以这里做编码嗅探 + 字符清洗。
function decodeTokenFile(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.toString('utf16le', 2);              // UTF-16LE + BOM
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.from(buf.subarray(2));   // UTF-16BE + BOM
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t;
    }
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.toString('utf8', 3);                 // UTF-8 + BOM
  }
  // 无 BOM：出现大量 \0 基本可判定为 UTF-16LE
  const nulCount = buf.subarray(0, Math.min(buf.length, 64)).filter(b => b === 0).length;
  return nulCount > 8 ? buf.toString('utf16le') : buf.toString('utf8');
}
function cleanToken(raw) {
  return String(raw)
    .replace(/^\uFEFF/, '')                  // BOM
    .replace(/[\u200B-\u200D\uFEFF]/g, '')   // 零宽字符
    .replace(/\s+/g, '');                    // 所有空白（含换行/制表）
}
function loadToken() {
  if (process.env.GH_TOKEN) {
    const t = cleanToken(process.env.GH_TOKEN);
    if (t) return t;
  }
  for (const p of [
    join(ROOT, '..', '_token.txt'),
    join(ROOT, '_token.txt')
  ]) {
    if (existsSync(p)) {
      const t = cleanToken(decodeTokenFile(readFileSync(p)));
      if (t) return t;
    }
  }
  throw new Error('找不到 GitHub token：请设置 GH_TOKEN，或把 token 放到工作区的 _token.txt');
}
const TOKEN = loadToken();
if (!/^[A-Za-z0-9_.\-]+$/.test(TOKEN)) {
  throw new Error('token 清洗后仍含非法字符，长度=' + TOKEN.length);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- HTTP ---------- */
function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'jungle-coach-publish',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + TOKEN,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {})
      }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { /* 可能是空响应 */ }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function httpGet(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'jungle-coach-check', 'Cache-Control': 'no-cache' }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}

/* ---------- 步骤 1：校验 token ---------- */
const me = await api('GET', '/user');
if (me.status !== 200) {
  throw new Error('token 无效或权限不足 (HTTP ' + me.status + '): ' + (me.body && me.body.message));
}
const login = me.body.login;
console.log('[1/5] token 有效，账号:', login);
if (login !== OWNER) {
  console.log('      注意：token 属于 ' + login + '，但目标 owner 配的是 ' + OWNER);
}

/* ---------- 步骤 2：确保仓库存在 ---------- */
const repoPath = `/repos/${OWNER}/${REPO}`;
let repo = await api('GET', repoPath);
if (repo.status === 404) {
  const created = await api('POST', '/user/repos', {
    name: REPO,
    description: DESC,
    private: false,
    auto_init: true
  });
  if (created.status !== 201) {
    throw new Error('创建仓库失败: ' + created.status + ' ' + JSON.stringify(created.body));
  }
  console.log('[2/5] 仓库已创建:', OWNER + '/' + REPO);
  await sleep(2500);
} else if (repo.status === 200) {
  console.log('[2/5] 仓库已存在:', OWNER + '/' + REPO);
} else {
  throw new Error('查询仓库失败: ' + repo.status + ' ' + (repo.body && repo.body.message));
}

/* ---------- 步骤 3：提交文件 ---------- */
console.log('[3/5] 提交文件…');
let uploaded = 0;
for (const rel of FILES) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    console.log('      跳过（不存在）:', rel);
    continue;
  }
  const content = Buffer.from(readFileSync(abs, 'utf8'), 'utf8').toString('base64');
  const path = `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(rel).replace(/%2F/g, '/')}`;

  // 已存在则带上 sha 以覆盖
  const existing = await api('GET', `${path}?ref=${BRANCH}`);
  const body = { message: `chore: publish ${rel}`, content, branch: BRANCH };
  if (existing.status === 200 && existing.body && existing.body.sha) body.sha = existing.body.sha;

  const put = await api('PUT', path, body);
  if (put.status === 200 || put.status === 201) {
    uploaded++;
    console.log('      ✓', rel, '(' + Buffer.byteLength(content, 'base64') + ' bytes)');
  } else {
    throw new Error('提交失败 ' + rel + ': ' + put.status + ' ' + JSON.stringify(put.body));
  }
  await sleep(350);   // 轻微节流，避免触发 secondary rate limit
}
console.log('      共提交', uploaded, '个文件');

/* ---------- 步骤 4：开启 GitHub Pages ---------- */
console.log('[4/5] 配置 GitHub Pages…');
const pages = await api('PATCH', repoPath + '/pages', {
  source: { branch: BRANCH, path: '/', mode: 'legacy' },
  build_type: 'legacy'
});
if (pages.status === 200 || pages.status === 201 || pages.status === 204) {
  console.log('      Pages 已启用:', (pages.body && pages.body.url) || '(配置成功)');
} else if (pages.status === 409) {
  console.log('      Pages 已存在，跳过配置');
} else {
  // 有些情况下需要先 POST 创建
  const post = await api('POST', repoPath + '/pages', {
    source: { branch: BRANCH, path: '/' }
  });
  if (post.status === 201 || post.status === 200) {
    console.log('      Pages 已创建');
  } else {
    console.log('      ⚠ Pages 配置返回 ' + pages.status + '：' + (pages.body && pages.body.message));
    console.log('        可稍后在仓库 Settings → Pages 手动选择 main/(root)');
  }
}

/* ---------- 步骤 5：等待并验证线上跑的是本次构建 ---------- */
const URL = `https://${OWNER}.github.io/${REPO}/`;
console.log('[5/5] 等待 Pages 构建并验证:', URL);

/*
 * 验证的关键是比对「构建标记」，而不是「页面能打开」。
 * GitHub Pages 走 CDN，更新后旧版本还会被缓存一段时间；
 * 如果只检查 title 之类的通用字样，新旧版本都能通过，验证等于没做。
 * 所以从本地 index.html 读出 <meta name="build">，要求线上与之完全一致。
 */
const localHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
const buildMatch = localHtml.match(/<meta\s+name="build"\s+content="([^"]+)"/);
const BUILD = buildMatch ? buildMatch[1] : null;
if (!BUILD) {
  console.log('      ⚠ 本地 index.html 没有 <meta name="build">，只能做通用检查');
} else {
  console.log('      本次构建标记:', BUILD);
}

let live = false;
let sawOldVersion = false;
for (let i = 1; i <= 40; i++) {
  // 带随机 query 绕过 CDN 缓存，否则可能一直拿到旧版本
  const r = await httpGet(URL + '?cachebust=' + Date.now());
  if (r.status === 200) {
    if (!BUILD) {
      if (r.body.includes('打野教练')) { live = true; console.log(`      第 ${i} 次检查: 200 OK ✓`); break; }
    } else if (r.body.includes(`content="${BUILD}"`)) {
      live = true;
      console.log(`      第 ${i} 次检查: 200 OK，构建标记匹配 ✓`);
      break;
    } else {
      sawOldVersion = true;
      console.log(`      第 ${i} 次检查: 200 但仍是旧版本（CDN 缓存中），继续等待…`);
    }
  } else {
    console.log(`      第 ${i} 次检查: HTTP ${r.status}，继续等待…`);
  }
  await sleep(5000);
}

console.log('\n' + '─'.repeat(60));
console.log('仓库地址 :', `https://github.com/${OWNER}/${REPO}`);
console.log('线上地址 :', URL);
console.log('─'.repeat(60));
if (!live) {
  if (sawOldVersion) {
    console.log('线上仍在跑旧版本（Pages CDN 缓存），通常 1-2 分钟内会刷新。');
    console.log('若长时间不变，可在浏览器请求里加 ?v=' + Date.now() + ' 强制绕过缓存。');
  } else {
    console.log('页面可能仍在构建中（首次部署通常 1-2 分钟）。稍后刷新上面的线上地址即可。');
  }
  process.exitCode = 2;
} else {
  console.log('发布完成 ✓ 线上已确认是本次构建的版本');
}