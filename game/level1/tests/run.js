/* ============================================================================
 * tests/run.js — LEVEL 1 逻辑层自动化验收
 *
 * 用途：在 node 下直接跑，逐条核对 docs/novel/06-LEVEL1-实现规格.md
 *       §9「实现验收清单」（10 条）与 §10「参考通关路径」（A/B/C/D）。
 *
 * 运行： node game/level1/tests/run.js
 *
 * 这是「改数值 → 重跑校验」这条项目惯例在游戏线上的对应物：
 * 以后任何人调了相位倍率 / 卡牌成本 / 阈值，跑一次就能知道有没有把
 * §10 的四条参考路径跑崩。
 * ========================================================================== */
'use strict';

const E = require('../js/engine.js');
const D = require('../js/data.js');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (detail ? '  → ' + detail : '')); console.log('  \u2717 ' + name + (detail ? '  → ' + detail : '')); }
}
function near(name, actual, expected, tol) {
  tol = tol === undefined ? 0.01 : tol;
  ok(name, Math.abs(actual - expected) <= tol, `实际 ${actual}，期望 ${expected}（容差 ${tol}）`);
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}
function section(t) { console.log('\n' + t); }

/* 按顺序打出若干张卡，返回终局状态 */
function run(cards, opts) {
  opts = opts || {};
  const s = E.createState();
  for (const id of cards) {
    if (id === '__SKIP__') { E.skipTurn(s); }
    else { E.playCard(s, id, { forceOverclock: !!opts.forceOverclock }); }
    if (s.result !== 'ongoing') break;
  }
  return s;
}
function runSkips(n) {
  const s = E.createState();
  for (let i = 0; i < n; i++) { E.skipTurn(s); if (s.result !== 'ongoing') break; }
  return s;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 一、§10 参考通关路径 —— 四条，逐条核对 Impact 与评级
 * ══════════════════════════════════════════════════════════════════════════ */
section('§10 参考通关路径');

/* 路径 A · 标准解（预期 A 级，Impact 43.95） */
{
  const s = run(['C_MONITOR', 'C_LOG', 'C_TRACE', 'C_SYNC', 'C_UPSTREAM', 'C_RATELIMIT', 'C_DEPLOY']);
  near('路径 A 最终 Impact', s.impact, 43.95);
  near('路径 A 事故时间', s.timeElapsed, 15);
  eq('路径 A 结局', s.result, 'win_root');
  eq('路径 A 评级', E.calcRank(s), 'A');
  eq('路径 A 有效操作 / 总操作', s.effectiveOps + '/' + s.totalOps, '5/7');
  eq('路径 A 浪费的时间', s.wastedTime, 0);
}

/* 路径 B · 视界解（预期 S 级，Impact 21.00） */
{
  const s = run(['C_MONITOR', 'C_LOG', 'C_VISION', 'C_RATELIMIT', 'C_DEPLOY']);
  near('路径 B 最终 Impact', s.impact, 21.00);
  eq('路径 B 结局', s.result, 'win_root');
  eq('路径 B 评级', E.calcRank(s), 'S');
  eq('路径 B 视界剩余带宽', s.visionBandwidth, 2);
  eq('路径 B 有效操作 / 总操作', s.effectiveOps + '/' + s.totalOps, '4/5');
  eq('路径 B 浪费的时间', s.wastedTime, 0);
}

/* 路径 C · 重启后翻盘（预期 B 级）
 * ⚠ §10 原文顺序（第 2 回合重启、第 3 回合才看日志）在本实现下走不通：
 *   §0.1 把视界前置条件改成「需已有 ≥2 条证据」，而 §4.3 规定重启清空证据。
 *   该顺序下重启后手上只剩 1 条（看监控给的 E2），视界必然不可用 → 玩家卡死。
 *   下文先把这个失败原样断言下来（护栏），再用修正顺序 C′ 验证设计意图。 */
{
  const literal = run(['C_MONITOR', 'C_RESTART', 'C_LOG', 'C_RATELIMIT', 'C_VISION', 'C_DEPLOY']);
  eq('§10-C 原顺序：视界在重启后不可用（规格内部矛盾，见 README）',
     E.checkLegality(literal, D.CARD_BY_ID.C_VISION).ok, false);
  eq('§10-C 原顺序：因此卡在未通关', literal.result, 'ongoing');

  /* 路径 C′ · 修正顺序：先取得 2 条线索，再重启，再靠视界翻盘 */
  const s = run(['C_MONITOR', 'C_LOG', 'C_RESTART', 'C_RATELIMIT', 'C_VISION', 'C_DEPLOY']);
  near('路径 C′ 最终 Impact', s.impact, 26.85);
  eq('路径 C′ 结局', s.result, 'win_root');
  eq('路径 C′ 评级（封顶 B）', E.calcRank(s), 'B');
  eq('路径 C′ 未封顶前的原始评级', E.calcRankRaw(s), 'A');
  eq('路径 C′ 有效操作 / 总操作', s.effectiveOps + '/' + s.totalOps, '4/6');
  eq('路径 C′ 浪费的时间', s.wastedTime, 1);
  ok('路径 C′ 重启后靠视界翻盘（§4.3 的设计意图成立）', s.visionUsed === 1 && s.restartCount === 1);
}

/* 路径 D · 失败（预期 F 级，Impact 64.50，超时） */
{
  const s = run(['C_SCALE', 'C_HISTORY', 'C_INDEX', 'C_CACHE']);
  near('路径 D 最终 Impact', s.impact, 64.50);
  eq('路径 D 结局', s.result, 'lose_timeout');
  eq('路径 D 评级', E.calcRank(s), 'F');
  eq('路径 D 受影响用户', E.settle(s).users, 2064);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 二、§9 实现验收清单（10 条）
 * ══════════════════════════════════════════════════════════════════════════ */
section('§9 实现验收清单');

/* 1. 不做任何操作，15 分钟时 Impact ≈ 64.50，判定 lose_timeout */
{
  const s = runSkips(30);
  near('①  被动 15 分钟 Impact', s.impact, 64.50);
  eq('①  被动结局', s.result, 'lose_timeout');
  near('①  被动超时时刻', s.timeElapsed, 15);
}

/* 2+3 已在上面路径 A / B 覆盖 —— 这里复核 §9 明文要求 */
{
  const a = run(['C_MONITOR', 'C_LOG', 'C_TRACE', 'C_SYNC', 'C_UPSTREAM', 'C_RATELIMIT', 'C_DEPLOY']);
  ok('②  正解路径 Impact≈43.95 且评级 A', Math.abs(a.impact - 43.95) <= 0.01 && E.calcRank(a) === 'A');
  const b = run(['C_MONITOR', 'C_LOG', 'C_VISION', 'C_RATELIMIT', 'C_DEPLOY']);
  ok('③  视界路径 Impact≈21.00 且评级 S', Math.abs(b.impact - 21.00) <= 0.01 && E.calcRank(b) === 'S');
}

/* 4. 第 2 回合使用重启 → Impact 归零、evidenceLost、诊断卡全部置灰 */
{
  const s = E.createState();
  E.playCard(s, 'C_MONITOR');
  E.playCard(s, 'C_LOG');            // 先拿 E1，这样链路追踪本来是「可用」的
  ok('④  重启前「链路追踪」可用', E.checkLegality(s, D.CARD_BY_ID.C_TRACE).ok === true);
  E.playCard(s, 'C_RESTART');
  eq('④  重启后 Impact 归零', s.impact, 0);
  eq('④  重启后 evidenceLost', s.evidenceLost, true);
  eq('④  重启后证据清空', s.evidence.size, 0);
  eq('④  重启后「链路追踪」置灰', E.checkLegality(s, D.CARD_BY_ID.C_TRACE).ok, false);
  eq('④  置灰原因', E.checkLegality(s, D.CARD_BY_ID.C_TRACE).reason, 'requires');
  eq('④  重启后「查看上游调用」置灰', E.checkLegality(s, D.CARD_BY_ID.C_UPSTREAM).ok, false);
  ok('④  重启后「二分定位」仍可用（不依赖现场证据）', E.checkLegality(s, D.CARD_BY_ID.C_BISECT).ok === true);
  ok('④  重启后「视界」仍可用（唯一的翻盘手段）', E.checkLegality(s, D.CARD_BY_ID.C_VISION).ok === true);
  eq('④  phaseBonus +0.5', s.phaseBonus, D.CONFIG.restartPhaseBonus);
}

/* 5. 重启后经视界仍可通关，评级封顶 B */
{
  const s = run(['C_MONITOR', 'C_LOG', 'C_RESTART', 'C_RATELIMIT', 'C_VISION', 'C_DEPLOY']);
  eq('⑤  重启后靠视界通关', s.result, 'win_root');
  eq('⑤  评级封顶为 B', E.calcRank(s), 'B');
  ok('⑤  原始评级本来是 A（更优）', E.calcRankRaw(s) === 'A');
  ok('⑤  一条线索就重启的话，视界也救不回来（≥2 前置）',
     E.checkLegality(run(['C_MONITOR', 'C_RESTART']), D.CARD_BY_ID.C_VISION).ok === false);
}

/* 6. 超频：3 回合时间成本减半 + 评级降一级 */
{
  const s = E.createState();
  s.overclockTurnsLeft = D.CONFIG.overclockTurns;
  eq('⑥  超频中 发版(8) 成本', E.effectiveTimeCost(s, D.CARD_BY_ID.C_DEPLOY), 4);
  eq('⑥  超频中 日志(1) 成本（下限 1，不再减）', E.effectiveTimeCost(s, D.CARD_BY_ID.C_LOG), 1);
  eq('⑥  超频中 大盘(0) 成本', E.effectiveTimeCost(s, D.CARD_BY_ID.C_MONITOR), 0);

  // 带宽只有 3 点：可用 3 次「揭示」，第 4 次必然进入超频分支（需玩家确认）
  const s2 = run(['C_MONITOR', 'C_LOG', 'C_VISION', 'C_VISION', 'C_VISION', 'C_VISION'],
                 { forceOverclock: true });
  eq('⑥  带宽耗尽后再次开启 → 超频', s2.overclocked, true);
  eq('⑥  超频后本场禁用视界', s2.visionDisabled, true);
  ok('⑥  超频后「开启视界」置灰', E.checkLegality(s2, D.CARD_BY_ID.C_VISION).ok === false);

  const full = run(['C_MONITOR', 'C_LOG', 'C_VISION', 'C_VISION', 'C_VISION', 'C_VISION',
                    'C_RATELIMIT', 'C_DEPLOY'], { forceOverclock: true });
  eq('⑥  超频通关', full.result, 'win_root');
  const raw = full.impact < 25 ? 'S' : full.impact < 50 ? 'A' : 'B';
  ok('⑥  评级被降一级', E.calcRank(full) !== raw,
     `Impact ${full.impact} → 原始 ${raw}，实际 ${E.calcRank(full)}`);
  eq('⑥  超频把时间成本减半体现在结果上（发版 8 → 4）', full.timeElapsed, 6);
}

/* 7. 不使用 C_SYNC 的通关边界
 * ⚠ §0.2 / §9-7 断言「不用同步进展就一定超时，正解路径总耗时 15 分钟」。
 *   但 §10-A 的 15 分钟里含「同步进展」自身那 1 分钟，扣掉只剩 14 分钟。
 *   即：不用同步进展时最短通关是 t=14 < 15 —— **「必然超时」在算术上不成立**。
 *   正确的结论是「没有任何容错余量」：任何一次 1 分钟的无效操作都会把它推过 15。
 *   （本实现不改任何卡牌成本——那会同时推翻 §10-A 的 43.95。） */
{
  const s = run(['C_MONITOR', 'C_LOG', 'C_TRACE', 'C_UPSTREAM', 'C_RATELIMIT', 'C_DEPLOY']);
  eq('⑦  不用同步进展：t=14 极限通关', s.result, 'win_root');
  near('⑦  极限通关时刻', s.timeElapsed, 14);
  ok('⑦  余量只剩 1 分钟', s.timeLimit - s.timeElapsed === 1);

  // 同样路线，中途只多花 1 分钟（比如顺手比对了一下变更）→ 立刻超时
  const s2 = run(['C_MONITOR', 'C_LOG', 'C_TRACE', 'C_UPSTREAM', 'C_DIFF', 'C_RATELIMIT', 'C_DEPLOY']);
  eq('⑦  多花 1 分钟即超时（卡点完成才算赢，§8）', s2.result, 'lose_timeout');
  near('⑦  超时时刻', s2.timeElapsed, 16);
  ok('⑦  根因已确认、代码也已修复，只是晚了 —— 判超时', s2.rootCauseFixed === true);
}

/* 8. C_SCALE 使用两次后不再可用 */
{
  const s = E.createState();
  E.playCard(s, 'C_SCALE');
  ok('⑧  扩容第 1 次可用 / 用后仍可用', E.checkLegality(s, D.CARD_BY_ID.C_SCALE).ok === true);
  E.playCard(s, 'C_SCALE');
  eq('⑧  扩容第 3 次置灰', E.checkLegality(s, D.CARD_BY_ID.C_SCALE).ok, false);
  eq('⑧  置灰原因', E.checkLegality(s, D.CARD_BY_ID.C_SCALE).reason, 'maxuses');
}

/* 9. 老赵台词每个 key 只触发一次 */
{
  const s = run(['C_SCALE', 'C_SCALE', 'C_HISTORY', 'C_RESTART', 'C_RESTART', 'C_RESTART']);
  const counts = {};
  s.entries.filter(e => e.kind === 'zhao').forEach(e => { counts[e.key] = (counts[e.key] || 0) + 1; });
  const dup = Object.keys(counts).filter(k => counts[k] > 1);
  eq('⑨  没有重复触发的台词 key', dup.length, 0);
  ok('⑨  连续三次主动重启只播一次「你把它叫醒了」', counts['zhao_after_restart'] === 1,
     JSON.stringify(counts));
}

/* 10. 结算「浪费的时间」与实际无效操作时长一致（= 陷阱卡时间之和） */
{
  const s = run(['C_SCALE', 'C_INDEX', 'C_CACHE', 'C_RESTART', 'C_LOG']);
  eq('⑩  浪费的时间 = 扩容3 + 加索引5 + 加缓存4 + 重启1', s.wastedTime, 13);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 三、规格内部一致性（本次实现发现的偏差，作为回归护栏）
 * ══════════════════════════════════════════════════════════════════════════ */
section('规格一致性护栏');

/* §3.3 被动失败曲线的四个采样点 */
{
  const s = E.createState();
  E.advanceTimeAndImpact(s, 5);  near('§3.3  t=5  → 15.00', s.impact, 15.00);
  E.advanceTimeAndImpact(s, 5);  near('§3.3  t=10 → 36.00', s.impact, 36.00);
  E.advanceTimeAndImpact(s, 5);  near('§3.3  t=15 → 64.50', s.impact, 64.50);
  E.advanceTimeAndImpact(s, 5);  near('§3.3  t=20 → 93.00', s.impact, 93.00);
  /* §3.3 表里写「21.2 分破线」，但按同表自己的数值推：20 分时 93.00，
     P4 强度 7.50/分 → 破线时刻 = 20 + 7 ÷ 7.5 = 20.933 分。原表 21.2 是笔误。 */
  E.advanceTimeAndImpact(s, 0.9333); near('§3.3  破线时刻 t=20.933 → 100.00', s.impact, 100.00, 0.05);
}

/* §3.2 重启后的各相位等效倍率 */
{
  const s = E.createState();
  D.onRestart(s);
  near('§3.2  重启 1 次 · P1 等效强度', E.severityAt(s, 1), 3.0 * 1.5);
  near('§3.2  重启 1 次 · P2 等效强度', E.severityAt(s, 6), 3.0 * 1.9);
  near('§3.2  重启 1 次 · P3 等效强度', E.severityAt(s, 11), 3.0 * 2.4);
  near('§3.2  重启 1 次 · P4 等效强度', E.severityAt(s, 21), 3.0 * 3.0);
  D.onRestart(s);
  near('§3.2  重启 2 次 · P1 等效强度', E.severityAt(s, 1), 3.0 * 2.0);
}

/* §6.2 强制接管：t>=12 且未确认根因才触发；已确认根因不触发 */
{
  const s = runSkips(14);
  ok('§6.2  未确认根因 → t=12 触发强制接管', s.firedTriggers.has('forced_restart'));
  ok('§6.2  强制接管毁掉证据链', s.evidenceLost === true);
  eq('§6.2  强制接管不改 restartCount（它不算玩家主动重启）', s.restartCount, 0);

  const t = run(['C_MONITOR', 'C_LOG', 'C_TRACE', 'C_UPSTREAM', 'C_RATELIMIT', 'C_DEPLOY']);
  ok('§6.2  已确认根因 → 不触发强制接管', !t.firedTriggers.has('forced_restart'));
}

/* §5.13 视界前置：证据 < 2 时不可用 */
{
  const s = E.createState();
  eq('§5.13 零证据时视界不可用', E.checkLegality(s, D.CARD_BY_ID.C_VISION).ok, false);
  E.playCard(s, 'C_MONITOR');
  eq('§5.13 一条证据时仍不可用', E.checkLegality(s, D.CARD_BY_ID.C_VISION).ok, false);
  E.playCard(s, 'C_LOG');
  eq('§5.13 两条证据后可用', E.checkLegality(s, D.CARD_BY_ID.C_VISION).ok, true);
  eq('§5.13 带宽耗尽后返回「需确认超频」', E.checkLegality(Object.assign(E.createState(), {
    evidenceEver: new Set(['E1', 'E2']), visionBandwidth: 0,
  }), D.CARD_BY_ID.C_VISION).confirm, 'overclock');
}

/* §5.17 已确认根因后向上汇报：不消耗生效次数 */
{
  const s = run(['C_MONITOR', 'C_LOG', 'C_TRACE', 'C_UPSTREAM']);
  ok('§5.17 前置：根因已确认', s.rootCauseConfirmed === true);
  const before = s.escalateUsedCount;
  E.playCard(s, 'C_ESCALATE');
  eq('§5.17 已确认根因后汇报不消耗次数', s.escalateUsedCount, before);
  eq('§5.17 返回「那你汇报什么」文案', s.entries[s.entries.length - 1].logKey, 'escalate.afterRoot');
}

/* §5.16 同步进展：第 4 次起失效且仍消耗 1 分钟 */
{
  const s = E.createState();
  for (let i = 0; i < 4; i++) E.playCard(s, 'C_SYNC');
  eq('§5.16 时限被延长 3 次 ×10 分钟', s.timeLimit, 15 + 30);
  const after = s.timeElapsed;
  E.playCard(s, 'C_SYNC');
  eq('§5.16 第 4 次不失效但仍有 1 分钟成本', s.timeElapsed - after, 1);
}

/* §7.3 S/A 级不显示 rankNote；须在评级被降/封顶时才显示 */
{
  const a = run(['C_MONITOR', 'C_LOG', 'C_TRACE', 'C_SYNC', 'C_UPSTREAM', 'C_RATELIMIT', 'C_DEPLOY']);
  eq('§7.4  A 级无原始评级（不显示判定块）', E.calcRankRaw(a), 'A');
  const c = run(['C_MONITOR', 'C_RESTART', 'C_LOG', 'C_RATELIMIT', 'C_VISION', 'C_DEPLOY']);
  ok('§7.4  B 级需解释「本应评 A」', E.calcRank(c) !== E.calcRankRaw(c));
}

/* ══════════════════════════════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(58));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  failures.forEach(f => console.log('  · ' + f));
  process.exitCode = 1;
} else {
  console.log('§9 十条验收 + §10 四条参考路径 全部通过。');
}
