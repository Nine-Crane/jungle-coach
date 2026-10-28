// tools/sim.mjs — 无头模拟器 / 数值平衡校验
// 用法: node tools/sim.mjs [局数]
//
// 原理：读取 index.html，抽出内联游戏脚本，注入最小 DOM stub 后在 vm 中执行，
// 然后反复自动对局，统计不同策略下的胜率与决策质量，用来校验数值平衡。
//
// 三种策略：
//   random — 完全随机选动作（基线：正常人瞎打）
//   max    — 每回合选期望收益最高的动作（理论上限）
//   farm   — 只会刷野的玩家（典型的"刷子打野"）

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = join(HERE, '..', 'index.html');

const src = readFileSync(HTML, 'utf8');

// ---- 抽出内联脚本（最后一个 <script> 块，无 src） ----
const blocks = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!blocks.length) throw new Error('index.html 中找不到内联脚本');
const code = blocks[blocks.length - 1][1];
console.log(`[sim] 脚本长度 ${code.length} 字符`);

// ---- 最小 DOM stub ----
function fakeEl() {
  return {
    innerHTML: '', textContent: '', className: '', disabled: false,
    style: {}, onclick: null, appendChild() {}, addEventListener() {},
    classList: {
      add() {}, remove() {}, contains() { return false; }, toggle() {}
    },
    getContext() {
      const noop = () => {};
      return {
        setTransform: noop, clearRect: noop, fillRect: noop, strokeRect: noop,
        beginPath: noop, arc: noop, fill: noop, stroke: noop,
        moveTo: noop, lineTo: noop, closePath: noop, save: noop, restore: noop,
        fillText: noop, setLineDash: noop,
        measureText: () => ({ width: 10 }),
        createLinearGradient: () => ({ addColorStop: noop })
      };
    }
  };
}
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

const sandbox = { document, window: {}, console, Math, JSON, Date, __DEV__: true };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'index.html:inline' });

const hook = sandbox.__TEST__;
if (!hook) throw new Error('缺少 __TEST__ 导出（检查 index.html 中的 DEV 钩子）');

// ---- 策略 ----
// 除了 pure-EV 策略，这里还实现了两个"人类启发式"策略作为对照基准。
// 目的：如果启发式策略的成绩明显好于 pickMax（纯按期望值选），
// 就说明引擎的 EV 权重模型与真实结算不一致，需要回去调数值。
function pickRandom(scored) {
  return scored[Math.floor(Math.random() * scored.length)];
}
function pickMax(scored) {
  return scored.reduce((m, x) => (x.ev > m.ev ? x : m), scored[0]);
}
function pickFarmFirst(scored) {
  const farm = scored.find(x => x.action.type === 'FARM');
  return farm || pickRandom(scored);
}
function find(scored, pred) {
  return scored.find(x => pred(x.action, x));
}
// 启发式策略 A：无脑优先打龙（很多中低分段的真实习惯）
function pickObjFirst(scored) {
  return find(scored, a => a.type === 'OBJ') || pickMax(scored);
}
// 启发式策略 B：接近高分段打野的判断顺序
function pickSmart(scored, g) {
  const healthy = g.health > 0.45;
  const threat = scored
    .filter(x => x.action.type === 'HOLD')
    .sort((a, b) => b.ev - a.ev)[0];

  // 1) 该回城就回城
  if (!healthy) {
    const recall = find(scored, a => a.type === 'RECALL');
    if (recall && (!threat || recall.ev > threat.ev - 60)) return recall;
  }
  // 2) 被抓得最惨的那条线正在被压 → 去守
  if (threat && threat.ev >= 150) return threat;
  // 3) 有团队资源且敌方打野位置不危险 → 拿
  const obj = scored.filter(x => x.action.type === 'OBJ' && x.risk < 0.35)
    .sort((a, b) => b.ev - a.ev)[0];
  if (obj) return obj;
  // 4) 有线权且成功率高的 Gank
  const gank = scored.filter(x => x.action.type === 'GANK' && x.ev > 200)
    .sort((a, b) => b.ev - a.ev)[0];
  if (gank) return gank;
  // 5) 有 BUFF 就吃
  const farm = find(scored, a => a.type === 'FARM' && /BUFF/.test(a.label || ''));
  if (farm) return farm;
  // 6) 有利可图的反野
  const inv = find(scored, a => a.type === 'INVADE' && a.ev > 250);
  if (inv) return inv;
  return pickMax(scored);
}
const POLICIES = {
  random: pickRandom,
  max: pickMax,
  objFirst: pickObjFirst,
  smart: pickSmart,
  farm: pickFarmFirst
};

// ---- 单局模拟 ----
function playOne(policyName) {
  const policy = POLICIES[policyName];
  const g = hook.newGame();
  hook.setGame(g);
  // 记录每类动作"出现过多少次"与"被选中多少次"，以区分两种失效：
  //   从没出现 → 生成逻辑问题；出现了但从不被选 → 数值问题。
  const appeared = {};
  const chosen = {};
  let guard = 0;
  while (!g.over && guard++ < 200) {
    const scored = hook.buildScored();
    if (!scored.length) throw new Error('回合没有可选动作 —— 引擎可能死锁');
    // 按动作"类型"统计（FARM/GANK/...），不要按显示标签切分——
    // 中文标签里并不保证有空格（例如"蹲草守护 上路"、"入侵敌方野区"），
    // 用标签当 key 会把它们拆错，得出"某动作从未被选"的假结论。
    scored.forEach(x => {
      appeared[x.action.type] = (appeared[x.action.type] || 0) + 1;
    });
    const choice = policy(scored, g);
    chosen[choice.action.type] = (chosen[choice.action.type] || 0) + 1;
    hook.applyChoice(choice, scored);
  }
  if (guard >= 200) throw new Error('对局未能结束，可能存在死循环');
  const st = hook.stats();
  st.appeared = appeared;
  st.chosen = chosen;
  return st;
}

// ---- 跑批量 ----
const N = Number(process.argv[2] || 300);
const results = {};

for (const name of Object.keys(POLICIES)) {
  const rows = [];
  for (let i = 0; i < N; i++) rows.push(playOne(name));
  const mean = k => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  const kinds = {};
  const appeared = {};
  rows.forEach(r => {
    for (const [k, v] of Object.entries(r.kindCount || {})) kinds[k] = (kinds[k] || 0) + v;
    for (const [k, v] of Object.entries(r.appeared || {})) appeared[k] = (appeared[k] || 0) + v;
  });
  const totalKind = Object.values(kinds).reduce((a, b) => a + b, 0) || 1;
  results[name] = {
    win: mean('won'),
    acc: mean('acc'),
    accRaw: mean('accRaw'),
    gold: mean('gold'),
    enemy: mean('enemyBase'),
    grief: mean('regret'),
    obj: mean('objCount'),
    gankOk: mean('gankOk'),
    deaths: mean('deaths'),
    kinds,
    appeared,
    totalKind
  };
}

console.log(`\n[sim] 每策略 ${N} 局\n`);
const pct = v => (v * 100).toFixed(1).padStart(5) + '%';
console.log('策略      胜率    决策质量   平均经济   敌方经济   机会成本   拿龙数  Gank成功  阵亡');
for (const [name, r] of Object.entries(results)) {
  console.log(
    name.padEnd(9),
    pct(r.win), '  ', pct(r.acc), '  ',
    r.gold.toFixed(0).padStart(8),
    r.enemy.toFixed(0).padStart(10),
    r.grief.toFixed(0).padStart(10),
    r.obj.toFixed(2).padStart(7),
    r.gankOk.toFixed(2).padStart(9),
    r.deaths.toFixed(2).padStart(7)
  );
}

// ---- 决策分布：验证"每个选项都有用武之地" ----
// 分组 key 使用动作类型（与 index.html 的 action.type 对应）。
console.log('\n[sim] 决策分布（各动作被选中的占比）');
const KINDS = ['FARM', 'GANK', 'INVADE', 'OBJ', 'HOLD', 'RECALL'];
const head = '策略     ' + KINDS.map(k => k.padStart(8)).join('') + '   ← 选中占比';
console.log(head);
for (const [name, r] of Object.entries(results)) {
  const cells = KINDS.map(k => {
    const p = (r.kinds[k] || 0) / r.totalKind * 100;
    return (p.toFixed(1) + '%').padStart(8);
  }).join('');
  console.log(name.padEnd(9) + cells);
}
// 这些动作是否曾出现在选项里（对照用：区分生成问题与数值问题）
const appCells = KINDS.map(k => {
  const tot = Object.values(results).reduce((s, r) => s + (r.appeared[k] || 0), 0);
  return (tot > 0 ? '有' : '无').padStart(8);
}).join('');
console.log('可选性   ' + appCells + '   ← 是否曾出现在选项里');

// ---- 平衡断言 ----
const checks = [];
checks.push(['随机策略不应轻松获胜（<55%）', results.random.win < 0.55]);
checks.push(['最优策略应显著优于随机（>+15pt）', results.max.win > results.random.win + 0.15]);
checks.push(['最优策略决策质量应显著高于随机（>+20pt）', results.max.acc > results.random.acc + 0.2]);
checks.push(['纯刷野不应成为最优解', results.farm.win < results.max.win]);
checks.push(['决策质量应落在 0~100% 之内', Object.values(results).every(r => r.acc >= 0 && r.acc <= 1)]);
checks.push(['最优策略必须真的要打龙（拿龙数 > 1）', results.max.obj > 1]);

const maxShare = k => (results.max.kinds[k] || 0) / results.max.totalKind;
checks.push(['Gank 在最优策略中应占实质比重（>5%）', maxShare('GANK') > 0.05]);
checks.push(['入侵不应成为无脑最优解（< 35%）', maxShare('INVADE') < 0.35]);
checks.push(['最优策略不应只靠单一动作（任意动作 < 55%）',
  Object.values(results.max.kinds).every(v => v / results.max.totalKind < 0.55)]);
checks.push(['至少 4 种动作在最优策略中有实际使用（>5%）',
  Object.values(results.max.kinds).filter(v => v / results.max.totalKind > 0.05).length >= 4]);
checks.push(['三类动作都可生成：INVADE / HOLD / RECALL 均出现过',
  ['INVADE', 'HOLD', 'RECALL'].every(k => (results.max.appeared[k] || 0) > 0)]);

console.log('');
let bad = 0;
for (const [label, ok] of checks) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + label);
  if (!ok) bad++;
}
console.log(bad ? `\n[sim] ${bad} 项断言未通过` : '\n[sim] 全部断言通过');
process.exitCode = bad ? 1 : 0;