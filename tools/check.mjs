// tools/check.mjs — 交付前自检
// 用法: node tools/check.mjs
//
// 检查四件事：
//   1) 内联脚本语法
//   2) DOM id 完整性（脚本引用的元素都存在）
//   3) 交付文件齐全
//   4) 渲染冒烟测试 —— 把整局 60 回合的界面渲染跑一遍
//
// 第 4 项很重要：本项目的交付物是一张 canvas 绘制的地图，
// 纯静态检查看不出渲染错误（比如引用了未定义的坐标常量）。
// 所以这里把脚本跑在最小 DOM stub 上，逐回合真实调用渲染函数。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const src = readFileSync(join(ROOT, 'index.html'), 'utf8');

let failed = 0;
const ok = (label, pass, extra = '') => {
  console.log((pass ? '  ✓ ' : '  ✗ ') + label + (extra ? '  ' + extra : ''));
  if (!pass) failed++;
};

/* ---------- 1) 内联脚本语法 ---------- */
const blocks = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
ok('存在内联脚本', blocks.length > 0, `(${blocks.length} 个)`);
const script = blocks[blocks.length - 1][1];
let syntaxError = null;
try { new Function(script); } catch (e) { syntaxError = e; }
ok('内联脚本语法有效', !syntaxError, syntaxError ? syntaxError.message : '');

/* ---------- 2) DOM 结构 ---------- */
const ids = ['map', 'hud', 'actions', 'feedback', 'intel', 'log', 'mask', 'report',
  'btnStart', 'btnHelp', 'mapTag', 'turnTag'];
const missing = ids.filter(id => !src.includes(`id="${id}"`));
ok('所有必需的 DOM id 都存在', missing.length === 0, missing.join(', '));

const used = [...new Set([...src.matchAll(/byId\('([^']+)'\)/g)].map(m => m[1]))];
const dead = used.filter(id => !src.includes(`id="${id}"`));
ok('byId 引用的 id 全部有对应元素', dead.length === 0, dead.join(', '));

/* ---------- 3) 内容与交付文件 ---------- */
ok('没有残留的调试打印', !/console\.log\(/.test(script));
ok('中立资源为暴君 + 主宰', src.includes("name:'暴君'") && src.includes("name:'主宰'"));
// 期望金必须从 UI 彻底移除：既不能有相关标记，也不能留下废弃的 CSS 规则。
// 注意要先把注释剥掉再搜「期望金」——注释里提到它是正常的；
// 而且 HTML 注释也必须剥，否则部署标记之类的文字会造成误报。
const srcNoComment = src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
ok('按钮上不再显示期望金',
  !/<span class="ev"/.test(src) && !/\.act\s+\.ev\b/.test(src) && !/期望金/.test(srcNoComment));
// 部署版本标记必须存在，否则发布脚本无法确认线上跑的版本
ok('存在部署版本标记 <meta name="build">',
  /<meta\s+name="build"\s+content="[^"]+"/.test(src));

for (const f of ['README.md', 'LICENSE', '.gitignore']) {
  let exist = true;
  try { readFileSync(join(ROOT, f)); } catch { exist = false; }
  ok(`交付文件存在: ${f}`, exist);
}

/* ---------- 4) 渲染冒烟测试 ---------- */
// 记录 canvas 的绘制调用次数，既验证"没抛异常"，也验证"确实画了东西"
function fakeEl() {
  const noop = () => {};
  const stats = { fills: 0, strokes: 0, texts: 0 };
  return {
    innerHTML: '', textContent: '', className: '', disabled: false,
    style: {}, onclick: null, appendChild() {}, addEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    __stats: stats,
    getContext() {
      return {
        setTransform: noop, clearRect: noop,
        fillRect: () => stats.fills++, strokeRect: () => stats.strokes++,
        beginPath: noop, arc: noop,
        fill: () => stats.fills++, stroke: () => stats.strokes++,
        moveTo: noop, lineTo: noop, closePath: noop, save: noop, restore: noop,
        fillText: () => stats.texts++, setLineDash: noop,
        measureText: () => ({ width: 10 }),
        createLinearGradient: () => ({ addColorStop: noop })
      };
    }
  };
}

let renderError = null;
let canvasStats = null;
let turnsRendered = 0;
try {
  const els = new Map();
  const document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, fakeEl());
      return els.get(id);
    },
    createElement() { return fakeEl(); },
    addEventListener() {},
    querySelector() { return fakeEl(); }
  };
  const sandbox = { document, console, Math, JSON, Date, __DEV__: true };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'index.html:inline' });

  const hook = sandbox.__TEST__;
  if (!hook) throw new Error('缺少 __TEST__ 导出');

  // 跑完整一局：每回合换一个动作，尽量覆盖各渲染分支
  const g = hook.newGame();
  hook.setGame(g);
  let guard = 0;
  while (!g.over && guard++ < 80) {
    const scored = hook.buildScored();
    if (!scored.length) throw new Error('回合没有可选动作');
    hook.applyChoice(scored[guard % scored.length], scored);
    hook.render();
    turnsRendered++;
  }
  // 再把地图单独渲染到几个关键时间点（资源刷新 / 暗影阶段 / 收尾）
  for (const t of [1, 8, 20, 32, 40, 55, 60]) {
    hook.setGame(hook.newGame());
    hook.warpTo(t);
    hook.renderMapOnly();
  }
  canvasStats = sandbox.document.getElementById('map').__stats;
} catch (e) {
  renderError = e;
}

ok('整局渲染无异常', !renderError, renderError ? renderError.message : '');
ok('渲染覆盖了整局回合', turnsRendered >= 55, `${turnsRendered} 回合`);
ok('渲染确实产生了绘制调用',
  !!canvasStats && canvasStats.fills > 100 && canvasStats.strokes > 50 && canvasStats.texts > 50,
  canvasStats ? `fill=${canvasStats.fills} stroke=${canvasStats.strokes} text=${canvasStats.texts}` : '无数据');

console.log('');
console.log(failed ? `[check] ${failed} 项未通过` : '[check] 全部通过');
process.exitCode = failed ? 1 : 0;