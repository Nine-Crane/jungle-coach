// tools/check.mjs — 交付前静态自检
// 用法: node tools/check.mjs
// 检查：内联脚本语法、DOM id 完整性、以及一些常见的低级错误。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '..', 'index.html'), 'utf8');

let failed = 0;
const ok = (label, pass, extra = '') => {
  console.log((pass ? '  ✓ ' : '  ✗ ') + label + (extra ? '  ' + extra : ''));
  if (!pass) failed++;
};

// 1) 内联脚本语法（用 Function 构造器编译，不执行）
const blocks = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
ok('存在内联脚本', blocks.length > 0, `(${blocks.length} 个)`);
let syntaxError = null;
try {
  new Function(blocks[blocks.length - 1][1]);
} catch (e) {
  syntaxError = e;
}
ok('内联脚本语法有效', !syntaxError, syntaxError ? syntaxError.message : '');

// 2) DOM id 必须齐全（脚本里 byId 用到的都要存在）
const ids = ['map', 'hud', 'actions', 'feedback', 'intel', 'log', 'mask', 'report',
  'btnStart', 'btnHelp', 'mapTag', 'turnTag'];
const missing = ids.filter(id => !src.includes(`id="${id}"`));
ok('所有必需的 DOM id 都存在', missing.length === 0, missing.join(', '));

// 3) 脚本里 byId('x') 引用的 id 都能在 HTML 中找到
const used = [...new Set([...src.matchAll(/byId\('([^']+)'\)/g)].map(m => m[1]))];
const dead = used.filter(id => !src.includes(`id="${id}"`));
ok('byId 引用的 id 全部有对应元素', dead.length === 0, dead.join(', '));

// 4) 常见低级错误
ok('没有残留的调试打印', !/console\.log\(/.test(blocks[blocks.length - 1][1]));
ok('内联脚本里没有未闭合的模板字符串残渣', !/\$\{[^}]*$/.test(blocks[blocks.length - 1][1]));
ok('Dragon/OBJ 常量存在', src.includes('OBJS') && src.includes('tyrant'));

// 5) 关键交付物存在
for (const f of ['README.md', 'LICENSE', '.gitignore']) {
  let exist = true;
  try { readFileSync(join(HERE, '..', f)); } catch { exist = false; }
  ok(`交付文件存在: ${f}`, exist);
}

console.log('');
console.log(failed ? `[check] ${failed} 项未通过` : '[check] 全部通过');
process.exitCode = failed ? 1 : 0;