/* ============================================================================
 * tests/ui-smoke.js — 界面层冒烟测试
 *
 * 用途：在 Node 里用一个极简 DOM 桩把 ui.js 真跑一遍，确认
 *   · 没有运行时错误（拼错的 id、undefined 的函数、模板占位符漏填）
 *   · 「开始 → 打牌 → 结算 → 再来一次」这条主链路是通的
 *   · 超频确认框、跳过回合、结算文案渲染都出得来
 *
 * 运行： node game/level1/tests/ui-smoke.js
 *
 * 它不替代浏览器里看，但能在改完 ui/texts 之后 1 秒内告诉你有没有把界面写崩。
 * ========================================================================== */
'use strict';

/* ── 极简 DOM 桩：只实现 ui.js 真正用到的那几个接口 ─────────────────────── */
function makeEl(id) {
  const el = {
    id, innerHTML: '', style: {}, scrollTop: 0, scrollHeight: 100,
    onclick: null, _h: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
    },
    addEventListener(ev, fn) { this._h[ev] = fn; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  // 真实 DOM 的 textContent 会把非字符串强制转换；桩必须一致，否则测出假失败
  let tc = '';
  Object.defineProperty(el, 'textContent', {
    get() { return tc; },
    set(v) { tc = String(v == null ? '' : v); },
  });
  return el;
}
const els = {};
global.document = {
  body: makeEl('body'),
  getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
};
global.window = global;
global.localStorage = { getItem() { return null; }, setItem() {} };

/* ── 按 index.html 的脚本顺序装载 ───────────────────────────────────────── */
global.CVData = require('../js/data.js');
global.CVTexts = require('../js/texts.js');
global.CVEngine = require('../js/engine.js');
require('../js/ui.js');

const E = global.CVEngine;
const G = global.cvGame;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (detail ? '  → ' + detail : '')); console.log('  \u2717 ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }
const $ = (id) => document.getElementById(id);

/* ══════════════════════════════════════════════════════════════════════════ */
(async function main() {

  section('装载与开场');
  ok('ui.js 装载后开了开场遮罩', $('overlay-host').innerHTML.indexOf('开始处置') >= 0);
  ok('开场遮罩里有开场四条文案', $('overlay-host').innerHTML.indexOf('入职第二天') >= 0);
  ok('开场遮罩里有等级副标题', $('overlay-host').innerHTML.indexOf('LEVEL 1') >= 0);

  $('btn-go').onclick();
  ok('点击开始后主界面显示', !$('app').classList.contains('hidden'));
  ok('状态已建立', !!G.getState() && G.getState().result === 'ongoing');
  ok('第 1 回合', $('turn-hint').textContent.indexOf('第 1 回合') >= 0);
  ok('左侧影响值已渲染', $('v-impact').textContent === '0.0');
  ok('卡池已渲染出「看监控大盘」', $('cards').innerHTML.indexOf('看监控大盘') >= 0);
  ok('卡池已渲染出「开启视界」', $('cards').innerHTML.indexOf('开启视界') >= 0);
  ok('「改代码 + 发版」初始置灰（未确认根因）', /data-card="C_DEPLOY"[^>]*disabled/.test($('cards').innerHTML));
  ok('「链路追踪」初始置灰（无 E1）', /data-card="C_TRACE"[^>]*disabled/.test($('cards').innerHTML));
  ok('开场提示已入记录', $('log').innerHTML.indexOf('8 点团队精力') >= 0);
  ok('状态栏干净时显示采集正常', $('statusbar').innerHTML.indexOf('全链路正常采集') >= 0);

  /* ── 走一遍标准解 ───────────────────────────────────────────────────── */
  section('主链路 · 标准解（路径 A）');
  ['C_MONITOR', 'C_LOG', 'C_TRACE', 'C_SYNC', 'C_UPSTREAM', 'C_RATELIMIT', 'C_DEPLOY']
    .forEach(id => G.play(id));

  const s = G.getState();
  ok('结局为根治通关', s.result === 'win_root', s.result);
  ok('等级为 A', E.calcRank(s) === 'A', E.calcRank(s));
  ok('记录里出现了「根因已确认」横幅', $('log').innerHTML.indexOf('根因已确认') >= 0);
  ok('记录里出现了发版流程文案', $('log').innerHTML.indexOf('全量发布') >= 0);
  ok('限流后常驻标记出现', $('statusbar').innerHTML.indexOf('HTTP 429') >= 0);
  ok('视界带宽 3 点未消耗', $('v-vision').textContent === '3');
  ok('证据栏列出了 E5 根因', $('evidence').innerHTML.indexOf('E5') >= 0);

  await sleep(900);
  section('结算界面');
  const ov = $('overlay-host').innerHTML;
  ok('结算遮罩已弹出', ov.indexOf('处置结果') >= 0);
  ok('显示等级 A', /class="rk A">A</.test(ov));
  ok('显示受影响用户', ov.indexOf('受影响用户') >= 0);
  ok('显示「有效操作」', ov.indexOf('有效操作') >= 0);
  ok('显示老赵结算台词', ov.indexOf('两年前那个人') >= 0);
  ok('显示复盘正文（缓解 vs 根治）', ov.indexOf('缓解不是为了解决问题') >= 0);
  ok('A 级不显示评级判定块', ov.indexOf('评级判定') < 0);

  $('btn-again').onclick();
  ok('「再来一次」重置了状态', G.getState().result === 'ongoing' && G.getState().timeElapsed === 0);

  /* ── 重启路径：验证评级判定块 ───────────────────────────────────────── */
  section('重启路径（路径 C′）· 评级判定块');
  ['C_MONITOR', 'C_LOG', 'C_RESTART', 'C_RATELIMIT', 'C_VISION', 'C_DEPLOY'].forEach(id => G.play(id));
  ok('重启后常驻标记出现', $('statusbar').innerHTML.indexOf('现场证据已丢失') >= 0);
  await sleep(900);
  const ov2 = $('overlay-host').innerHTML;
  ok('结局仍为根治通关', G.getState().result === 'win_root');
  ok('等级封顶为 B', /class="rk B">B</.test(ov2));
  ok('出现评级判定块', ov2.indexOf('评级判定') >= 0);
  ok('判定块说明了「本应评为 A」', ov2.indexOf('本应评为 A') >= 0);
  ok('判定块说明了「封顶为 B」', ov2.indexOf('封顶为 B') >= 0);
  ok('复盘正文是「现场证据的价值」', ov2.indexOf('先取证，再恢复') >= 0);
  $('btn-cont').onclick();
  ok('通关后「继续」给出待续画面', $('overlay-host').innerHTML.indexOf('沈青梧') >= 0);
  $('btn-end').onclick();
  ok('「待续」可关闭', $('overlay-host').innerHTML === '');

  /* ── 超频：确认框 ───────────────────────────────────────────────────── */
  section('超频确认框');
  $('btn-restart').onclick();
  ['C_MONITOR', 'C_LOG', 'C_VISION', 'C_VISION', 'C_VISION'].forEach(id => G.play(id));
  ok('3 次视界后带宽归零', $('v-vision').textContent === '0');
  G.play('C_VISION');
  ok('第 4 次视界弹出超频确认框', $('overlay-host').innerHTML.indexOf('强行开启') >= 0);
  ok('确认框写明了降级代价', $('overlay-host').innerHTML.indexOf('评级下降一级') >= 0);
  $('oc-yes').onclick();
  ok('确认后进入超频态', G.getState().overclocked === true);
  ok('超频后常驻标记出现', $('statusbar').innerHTML.indexOf('本场不可再用') >= 0);
  ok('超频后「开启视界」置灰', /data-card="C_VISION"[^>]*disabled/.test($('cards').innerHTML));
  await sleep(60);

  /* ── 失败路径 ───────────────────────────────────────────────────────── */
  section('失败路径 · 超时');
  $('btn-restart').onclick();
  for (let i = 0; i < 16; i++) G.skip();
  const f = G.getState();
  ok('结局为超时', f.result === 'lose_timeout', f.result);
  await sleep(900);
  const ov3 = $('overlay-host').innerHTML;
  ok('等级为 F', /class="rk F">F</.test(ov3));
  ok('标题为处置超时', ov3.indexOf('处置超时') >= 0);
  ok('复盘列出了时间花在哪', ov3.indexOf('你的时间花在哪') >= 0);
  ok('复盘给出了正确诊断顺序', ov3.indexOf('先看清楚，再动手') >= 0);
  ok('老赵说的是「第一次都这样」', ov3.indexOf('第一次都这样') >= 0);

  /* ── 模板占位符检查 ─────────────────────────────────────────────────── */
  section('模板占位符');
  $('btn-again').onclick();
  G.play('C_MONITOR');
  ok('监控大盘的 {impact}/{severity}/{remaining} 已填充',
     $('log').innerHTML.indexOf('{impact}') < 0 && $('log').innerHTML.indexOf('{severity}') < 0);
  G.play('C_SCALE');
  ok('扩容文案无占位符残留', $('log').innerHTML.indexOf('{') < 0 || $('log').innerHTML.indexOf('{amount}') < 0);

  /* ══════════════════════════════════════════════════════════════════════ */
  console.log('\n' + '─'.repeat(58));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { console.log('\n失败明细：'); failures.forEach(x => console.log('  · ' + x)); process.exitCode = 1; }
  else console.log('界面层主链路冒烟通过。');
})();
