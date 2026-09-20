/* ============================================================================
 * engine.js — 核心逻辑层（纯函数式状态机，无 DOM 依赖）
 *
 * 唯一来源：docs/novel/06-LEVEL1-实现规格.md
 *   §2.1 主循环      §2.2 时间与 Impact 分段积分
 *   §2.3 无操作回合   §3.1/3.2 相位与重启惩罚
 *   §4.2 根因确认     §4.3 重启对证据的影响
 *   §6.1/6.2 事件触发器
 *   §7.1/7.2/7.3 胜负判定与评级
 *
 * 本文件可被 Node 直接 require（见 tests/run.js）。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./data.js'));
  } else {
    root.CVEngine = factory(root.CVData);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DATA) {
  'use strict';

  var CONFIG = DATA.CONFIG;
  var PHASES = DATA.PHASES;
  var CARDS = DATA.CARDS;
  var CARD_BY_ID = DATA.CARD_BY_ID;

  /* ── 数值工具 ───────────────────────────────────────────────────────────── */
  function round2(x) { return Math.round(x * 100) / 100; }

  /* ── 相位与强度 §2.2 §3.1 ───────────────────────────────────────────────── */
  function phaseAt(state, t) {
    var p = PHASES.find(function (q) { return t >= q.start && t < q.end; });
    if (!p) p = PHASES[PHASES.length - 1];
    return { id: p.id, name: p.name, start: p.start, end: p.end, mod: p.mod + state.phaseBonus };
  }

  function severityAt(state, t) {
    var p = phaseAt(state, t);
    return round2(CONFIG.severityBase * p.mod * state.mitigationFactor);
  }
  DATA._injectSeverity(severityAt);   // 供「限流」卡反馈前后增速使用

  /* 分段积分 —— 必须按相位边界切分，不能一乘了事 */
  function advanceTimeAndImpact(state, deltaMinutes) {
    var remaining = deltaMinutes;
    var cursor = state.timeElapsed;
    var guard = 0;
    while (remaining > 1e-9) {
      if (++guard > 1000) break;
      var p = phaseAt(state, cursor);
      var slice = Math.min(remaining, p.end - cursor);
      state.impact += severityAt(state, cursor) * slice;
      cursor += slice;
      remaining -= slice;
    }
    state.timeElapsed = round2(cursor);
    state.impact = round2(state.impact);
  }

  /* ── 状态构造 §1.1 ──────────────────────────────────────────────────────── */
  function createState() {
    return {
      // 时间
      timeElapsed: 0,
      timeLimit: CONFIG.initialTimeLimit,
      // 故障
      impact: CONFIG.initialImpact,
      severityBase: CONFIG.severityBase,
      phaseBonus: 0,
      mitigationFactor: 1.0,
      restartCount: 0,
      // 调查
      evidence: new Set(),        // 现场证据 —— 重启会清空（§4.3）
      evidenceEver: new Set(),    // 曾经看到过的线索 —— 永不回退，视界前置用它（见 data.js 说明）
      rootCauseConfirmed: false,
      rootCauseFixed: false,
      evidenceLost: false,
      dataEventTriggered: false,
      // 资源
      visionBandwidth: CONFIG.initialVision,
      visionDisabled: false,
      visionUsed: 0,
      overclocked: false,
      overclockTurnsLeft: 0,
      teamStamina: CONFIG.initialStamina,
      teamStaminaMax: CONFIG.staminaMax,
      // 沟通
      syncCount: 0,
      escalateUsedCount: 0,
      escalationBlocked: false,
      // 流程
      turnIndex: 1,
      usedCards: new Map(),
      firedTriggers: new Set(),
      // 结算统计
      totalOps: 0,
      effectiveOps: 0,
      wastedTime: 0,
      usedSync: false,
      usedVision: false,
      usedEscalate: false,
      usedRestart: false,
      // 其他
      ratelimitOn: false,
      lastRestartImpactBefore: 0,
      // 结局
      result: 'ongoing',
      entries: [],
    };
  }

  /* ── 合法性与可用时间成本 §5.13 §8 ─────────────────────────────────────── */
  function effectiveTimeCost(state, card) {
    var t = card.timeCost;
    if (state.overclockTurnsLeft > 0 && t > 0) t = Math.max(1, Math.floor(t * 0.5));
    return t;
  }

  function maxUsesOf(card) {
    return (card.maxUses === undefined || card.maxUses === null) ? Infinity : card.maxUses;
  }

  /* 返回 { ok, reason?, confirm? } */
  function checkLegality(state, card) {
    if (state.result !== 'ongoing') return { ok: false, reason: 'over' };

    if (state.teamStamina < card.staminaCost) return { ok: false, reason: 'stamina' };

    if (card.requires && !card.requires(state)) return { ok: false, reason: 'requires' };

    // 视界带宽耗尽 → 允许，但需要玩家确认超频（全游戏唯一允许确认框的地方 §8）
    if (card.id === 'C_VISION' && state.visionBandwidth <= 0) return { ok: true, confirm: 'overclock' };

    var used = state.usedCards.get(card.id) || 0;
    if (used >= maxUsesOf(card)) return { ok: false, reason: 'maxuses' };

    return { ok: true };
  }

  /* ── 事件：阶段跨越 §6.1 ────────────────────────────────────────────────── */
  function firePhaseTriggers(state) {
    var trigs = [
      { key: 'enter_p2', t: 5,  logKey: 'event.p2' },
      { key: 'enter_p3', t: 10, logKey: 'event.p3' },
      { key: 'enter_p4', t: 20, logKey: 'event.p4' },
    ];
    trigs.forEach(function (tr) {
      if (state.timeElapsed >= tr.t && !state.firedTriggers.has(tr.key)) {
        state.firedTriggers.add(tr.key);
        push(state, { kind: 'event', logKey: tr.logKey, data: eventData(state) });
      }
    });
  }

  /* §4.1 的 {users} {orders} {amount} —— 由当前 Impact 实算 */
  function eventData(state) {
    var users = Math.round(state.impact * CONFIG.usersPerImpact);
    var orders = users + 1;
    return { users: users, orders: orders, amount: orders * CONFIG.avgOrderValue };
  }

  /* ── 事件：强制接管 §6.2 ────────────────────────────────────────────────── */
  function fireForcedRestart(state) {
    var key = 'forced_restart';
    if (state.timeElapsed >= CONFIG.forcedRestartAt &&
        !state.rootCauseConfirmed &&          // ← 关键条件：已找到根因的人不会被干扰
        !state.escalationBlocked &&
        !state.firedTriggers.has(key) &&
        state.result === 'ongoing') {
      state.firedTriggers.add(key);
      push(state, { kind: 'event', logKey: 'event.forced_restart', forced: true });
      DATA.onForcedRestart(state);            // 只毁证据链，不改数值（见 data.js 注释）
      return true;
    }
    return false;
  }

  /* ── 日志 ───────────────────────────────────────────────────────────────── */
  function push(state, entry) { state.entries.push(entry); return entry; }

  /* 老赵台词：每个 key 只触发一次（§6.3 / §9 验收第 9 条） */
  function pushZhao(state, key) {
    if (!key) return null;
    var k = 'zhao:' + key;
    if (state.firedTriggers.has(k)) return null;
    state.firedTriggers.add(k);
    return push(state, { kind: 'zhao', key: key });
  }
  function maybeZhaoAfterRestart(state) { return pushZhao(state, 'zhao_after_restart'); }

  /* ── 胜负判定 §7.1 ──────────────────────────────────────────────────────── */
  /* §2.1 要求「胜利判定必须在失败判定之前」，理由是发版完成时 t 可能恰好等于
   * timeLimit，若先判失败玩家会在通关瞬间被判超时。
   * §8 又要求「时限剩余 2 分钟打出 8 分钟的卡 → 时间推进后立即判定超时，让后果发生」。
   * 两者叠加的正确语义是：**卡点完成算赢，超时完成算输**。
   * 故胜利条件加上 `timeElapsed <= timeLimit`：
   *   t=15 / limit=15 → 赢（§2.1 的边界保护）
   *   t=16 / limit=15 → 交给失败判定 → lose_timeout（§8 的后果）
   */
  function checkVictory(state) {
    if (state.rootCauseFixed && state.timeElapsed <= state.timeLimit) {
      state.result = 'win_root'; return true;
    }
    if (state.mitigationFactor <= 0 && state.timeElapsed >= state.timeLimit) {
      state.result = 'win_mitigated'; return true;   // LEVEL 1 不可达 §7.1 注
    }
    return false;
  }

  function checkFailure(state) {
    if (state.dataEventTriggered) { state.result = 'lose_data'; return true; }
    if (state.impact >= CONFIG.impactThreshold) { state.result = 'lose_impact'; return true; }
    if (state.timeElapsed >= state.timeLimit) { state.result = 'lose_timeout'; return true; }
    return false;
  }

  /* ── 主循环 §2.1 ────────────────────────────────────────────────────────── */
  function playCard(state, cardId, opts) {
    opts = opts || {};
    var card = CARD_BY_ID[cardId];
    if (!card) return { ok: false, reason: 'unknown' };

    var legality = checkLegality(state, card);
    if (!legality.ok) return legality;

    // 超频需要确认
    if (legality.confirm === 'overclock' && !opts.forceOverclock) {
      return { ok: false, confirm: 'overclock' };
    }

    var uses = state.usedCards.get(cardId) || 0;
    var ctx = { first: uses === 0, uses: uses };

    // [2] 先结算时间与 Impact（你花了时间才做成这件事）
    var cost = effectiveTimeCost(state, card);
    if (cost !== card.timeCost) state.overclockTurnsLeft -= 1;   // 只在真减到时才消耗一次超频额度
    advanceTimeAndImpact(state, cost);

    // [3] 扣精力
    state.teamStamina -= card.staminaCost;

    // [4] 应用效果
    var res = card.effect(state, ctx);
    state.usedCards.set(cardId, uses + 1);

    // 统计
    state.totalOps += 1;
    var producedEvidence = (res.gainedEvidence || []).some(function (eid) {
      return !state.evidence.has(eid);
    });
    var advancedRoot = producedEvidence || res.celebrate === true ||
                       (cardId === 'C_DEPLOY' && state.rootCauseFixed);
    if (advancedRoot) state.effectiveOps += 1;
    if (card.trap) state.wastedTime += cost;

    if (res.gainedEvidence) res.gainedEvidence.forEach(function (eid) {
      state.evidence.add(eid);
      state.evidenceEver.add(eid);
    });

    if (cardId === 'C_SYNC') state.usedSync = true;
    if (cardId === 'C_ESCALATE' && !res.noConsume) state.usedEscalate = true;
    if (cardId === 'C_RESTART') state.usedRestart = true;
    if (cardId === 'C_VISION') state.usedVision = true;

    if (cardId === 'C_RESTART') {
      push(state, { kind: 'restart', logKey: res.logKey, impactBefore: state.lastRestartImpactBefore,
                    restartCount: state.restartCount });
    } else {
      push(state, { kind: 'card', cardId: cardId, logKey: res.logKey,
                    data: res.data || {}, effective: res.effective, celebrate: res.celebrate });
    }
    if (res.extraKey) push(state, { kind: 'aside', logKey: res.extraKey });
    if (res.zhao) pushZhao(state, res.zhao);

    // [5] 阶段事件
    firePhaseTriggers(state);
    // 强制接管（§6.2，放在胜负判定之前）
    if (fireForcedRestart(state)) maybeZhaoAfterRestart(state);

    // [6] 胜利判定（必须在失败判定之前 —— 发版完成时 t 可能恰好等于时限）
    if (checkVictory(state)) return finish(state);
    // [7] 失败判定
    if (checkFailure(state)) return finish(state);

    // 低时限催促台词
    if (state.timeLimit - state.timeElapsed <= 3) pushZhao(state, 'zhao_low_time');

    state.turnIndex += 1;
    return { ok: true, result: 'ongoing' };
  }

  /* ── 无操作回合 §2.3 ────────────────────────────────────────────────────── */
  function skipTurn(state) {
    if (state.result !== 'ongoing') return { ok: false, reason: 'over' };
    advanceTimeAndImpact(state, 1);
    state.totalOps += 1;
    state.wastedTime += 1;
    push(state, { kind: 'skip', logKey: 'ui.skip_log' });
    firePhaseTriggers(state);
    if (fireForcedRestart(state)) maybeZhaoAfterRestart(state);
    if (checkVictory(state)) return finish(state);
    if (checkFailure(state)) return finish(state);
    state.turnIndex += 1;
    return { ok: true, result: 'ongoing' };
  }

  function finish(state) {
    // §6.3 结算台词
    var key = state.result === 'win_root' ? 'zhao_on_win_root'
            : state.result === 'win_mitigated' ? 'zhao_on_win_mitigated'
            : 'zhao_on_lose';
    pushZhao(state, key);
    return { ok: true, result: state.result, settle: settle(state) };
  }

  /* ── 评级 §7.2 §7.3 ────────────────────────────────────────────────────── */
  function rankBetterThan(a, b) {
    var order = ['S', 'A', 'B', 'C', 'D'];
    return order.indexOf(a) < order.indexOf(b);
  }
  function demote(rank, state) {
    if (!state.overclocked) return rank;
    var order = ['S', 'A', 'B', 'C', 'D'];
    var i = order.indexOf(rank);
    return order[Math.min(i + 1, order.length - 1)];
  }

  function calcRank(state) {
    if (state.result === 'lose_impact' || state.result === 'lose_timeout' || state.result === 'lose_data') {
      return 'F';
    }
    if (state.result === 'win_mitigated') return demote('C', state);

    var rank;
    if (state.impact < 25) rank = 'S';
    else if (state.impact < 50) rank = 'A';
    else rank = 'B';

    if (state.restartCount > 0 && rankBetterThan(rank, 'B')) rank = 'B';
    return demote(rank, state);
  }

  /* 未封顶/未降级之前的原始评级 —— 结算界面的「评级判定块」要用 §7.4 */
  function calcRankRaw(state) {
    if (state.result !== 'win_root') return null;
    if (state.impact < 25) return 'S';
    if (state.impact < 50) return 'A';
    return 'B';
  }

  /* ── 结算 §7.4 ──────────────────────────────────────────────────────────── */
  function settle(state) {
    var users = Math.round(state.impact * CONFIG.usersPerImpact);
    var rank = calcRank(state);
    var raw = calcRankRaw(state);
    return {
      rank: rank,
      rankRaw: raw,
      result: state.result,
      timeElapsed: state.timeElapsed,
      timeLimit: state.timeLimit,
      impact: state.impact,
      users: users,
      orders: users + 1,
      amount: (users + 1) * CONFIG.avgOrderValue,
      restartCount: state.restartCount,
      visionUsed: state.visionUsed,
      overclocked: state.overclocked,
      evidenceLost: state.evidenceLost,
      syncCount: state.syncCount,
      effective: state.effectiveOps,
      total: state.totalOps,
      wasted: state.wastedTime,
      rootCauseFixed: state.rootCauseFixed,
    };
  }

  /* 结算的复盘建议 §6（07 文档） */
  function suggestions(state, s) {
    var out = [];
    if (s.wasted >= 5) out.push('wasted');
    if (s.restartCount > 0) out.push('restart');
    if (s.syncCount === 0) out.push('noSync');
    if (s.visionUsed === 0 && ['B', 'C', 'D', 'F'].indexOf(s.rank) >= 0) out.push('noVision');
    if (s.evidenceLost && !s.rootCauseFixed) out.push('lostEvidence');
    if (s.total > 0 && s.effective / s.total < 0.5) out.push('lowRatio');
    return out;
  }

  return {
    CONFIG: CONFIG,
    createState: createState,
    phaseAt: phaseAt,
    severityAt: severityAt,
    advanceTimeAndImpact: advanceTimeAndImpact,
    effectiveTimeCost: effectiveTimeCost,
    maxUsesOf: maxUsesOf,
    checkLegality: checkLegality,
    playCard: playCard,
    skipTurn: skipTurn,
    firePhaseTriggers: firePhaseTriggers,
    fireForcedRestart: fireForcedRestart,
    checkVictory: checkVictory,
    checkFailure: checkFailure,
    calcRank: calcRank,
    calcRankRaw: calcRankRaw,
    settle: settle,
    suggestions: suggestions,
    eventData: eventData,
  };
});
