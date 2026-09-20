/* ============================================================================
 * 《代码视界》· 游戏原型 · LEVEL 1《幽灵订单》
 * data.js — 数据层：相位表 / 证据表 / 卡牌表 / 全局常量
 *
 * 唯一来源：docs/novel/06-LEVEL1-实现规格.md
 *   相位表      → §3.1
 *   证据表      → §1.2
 *   卡牌表      → §5.2 §5.3–§5.17
 *   常量        → §1.1 §3.2 §7.4
 *
 * 本文件不依赖 DOM，可被 Node 直接 require（见 tests/run.js）。
 * ========================================================================== */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.CVData = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ── 全局常量 ───────────────────────────────────────────────────────────── */
  var CONFIG = {
    impactThreshold: 100,     // §1.1 impact >= 100 立即失败
    severityBase: 3.0,        // §0.1 + §3.1  原 4.0，详细设计时下调
    initialTimeLimit: 15,     // §7.1 LEVEL 1 时限
    initialImpact: 0,
    initialVision: 3,         // §5.3 带宽
    restartPhaseBonus: 0.5,   // §3.2 每次重启 +0.5，永久累加

    /* ⚠ 与规格 §1.1 的偏差（唯一一处）────────────────────────────────────
     * 规格 §1.1 写 `teamStamina 初值 5 / teamStaminaMax 5`。
     * 但 §10 路径 A（标准解）需要精力：
     *     看监控 0 + 看日志 0 + 链路追踪 1 + 同步进展 1
     *   + 查看上游调用 1 + 限流 1 + 改代码发版 3  =  7 点  >  5 点
     * 即：**按 5 点实现的路径 A 物理不可达**，与 §9 验收清单第 2 条
     * （"正解路径打出后 Impact≈43.95，评级 A"）直接冲突。
     * 判定为规格笔误（详细设计时删掉了 `拉人进来` 回精力的卡，却没同步上调精力上限）。
     * 本实现取 8，使 §9 全部 10 条验收项可过，并保留 1 点容错。
     * → 详见 game/level1/README.md「与规格的偏差」。
     */
    staminaMax: 8,
    initialStamina: 8,

    usersPerImpact: 32,       // §7.4 受影响用户 = round(impact × 32)
    avgOrderValue: 288,       // §4.1 event.p3 的 {amount} 用；规格未给，本实现自定义
    syncLimit: 3,             // §5.16 最多 3 次生效
    syncBonus: 10,            // §5.16 每次 +10 分钟
    overclockTurns: 3,        // §5.13 超频后 3 回合时间成本 ×0.5
    escalateLimit: 1,         // §5.17 只生效 1 次
    forcedRestartAt: 12,      // §6.2 t >= 12 且未确认根因 → 强制接管
  };

  /* ── 相位表 §3.1 ────────────────────────────────────────────────────────── */
  var PHASES = [
    { id: 'P1', name: '轻度', start: 0,  end: 5,        mod: 1.0 },
    { id: 'P2', name: '恶化', start: 5,  end: 10,       mod: 1.4 },
    { id: 'P3', name: '严重', start: 10, end: 20,       mod: 1.9 },
    { id: 'P4', name: '失控', start: 20, end: Infinity, mod: 2.5 },
  ];

  /* ── 证据表 §1.2 ────────────────────────────────────────────────────────── */
  var EVIDENCES = {
    E1: { id: 'E1', source: 'C_LOG',     tag: '形状',  label: '两次创建间隔 40–60ms' },
    E2: { id: 'E2', source: 'C_MONITOR', tag: '排除',  label: '数据库 CPU 23%、连接数 12/50、网络正常' },
    E3: { id: 'E3', source: 'C_TRACE',   tag: '指向',  label: '上游调用恰好 500ms 超时后立即重发' },
    E4: { id: 'E4', source: 'C_DIFF',    tag: '排除',  label: '最近 24 小时无任何发布或配置变更' },
    E5: { id: 'E5', source: 'C_UPSTREAM',tag: '根因',  label: '上游：500ms 超时 + 固定间隔重试 3 次，未配幂等键' },
    E6: { id: 'E6', source: 'C_LOG',     tag: '解释',  label: '订单服务 P99 响应 620ms，超过 500ms 阈值' },
    E7: { id: 'E7', source: 'C_HISTORY', tag: '背景',  label: '该故障历史出现 37 次，从未被彻底修复' },
  };

  /* ── 卡牌表 §5.2 ────────────────────────────────────────────────────────── */
  /* 字段说明
   *   timeCost / staminaCost   §5.2
   *   requires(state)          前置条件，不满足则置灰
   *   maxUses                  次数上限
   *   trap                     纯陷阱卡（扩容/加缓存/加索引/重启）—— 计入「浪费的时间」
   *   effect(state, ctx)       返回 { logKey, gainedEvidence?, effective, ... }
   *                            ctx.first = 本卡是否为首次使用
   *                            注意：调用时 usedCards 尚未自增，故 ctx.uses === 历史次数
   */
  var CARDS = [
    /* ── 观测类 ── */
    {
      id: 'C_MONITOR', name: '看监控大盘', category: 'observe',
      timeCost: 0, staminaCost: 0, maxUses: Infinity,
      cardDesc: '不用花时间。先看看现在什么样。',
      detail: '显示当前影响值、各服务健康状态、错误率。',
      effect: function (s, ctx) {
        return {
          logKey: 'monitor.dashboard',
          extraKey: ctx.first ? 'monitor.dashboard.extra' : null,
          gainedEvidence: ['E2'],
          effective: true,
        };
      },
    },
    {
      id: 'C_LOG', name: '看日志', category: 'observe',
      timeCost: 1, staminaCost: 0, maxUses: 2,
      cardDesc: '最笨的办法，也是最常用的办法。',
      detail: '翻最近的订单服务日志。',
      effect: function (s, ctx) {
        if (s.evidenceLost) return { logKey: 'log.afterRestart', effective: false };
        if (ctx.uses === 0) return { logKey: 'log.first',  gainedEvidence: ['E1'], effective: true };
        return { logKey: 'log.second', gainedEvidence: ['E6'], effective: true };
      },
    },
    {
      id: 'C_TRACE', name: '链路追踪', category: 'diagnose',
      timeCost: 2, staminaCost: 1, maxUses: Infinity,
      cardDesc: '跟着一个请求，看它到底走了哪条路。',
      detail: '需要先看过日志。',
      requires: function (s) { return s.evidence.has('E1'); },
      effect: function (s) {
        if (s.evidence.has('E3')) return { logKey: 'trace.repeat', effective: false };
        return { logKey: 'trace.first', gainedEvidence: ['E3'], effective: true };
      },
    },
    {
      id: 'C_HISTORY', name: '翻历史记录', category: 'observe',
      timeCost: 3, staminaCost: 1, maxUses: 1,
      cardDesc: '老赵说：这毛病以前犯过。',
      detail: '查这个故障在历史上的出现记录。',
      effect: function () {
        return { logKey: 'history.first', gainedEvidence: ['E7'], effective: true, zhao: 'zhao_after_history' };
      },
    },

    /* ── 诊断类 ── */
    {
      id: 'C_BISECT', name: '二分定位', category: 'diagnose',
      timeCost: 3, staminaCost: 1, maxUses: 2,
      cardDesc: '一次砍掉一半可能性。',
      detail: '对比所有服务实例的指标，排除不可能的假设。',
      effect: function (s, ctx) {
        return ctx.uses === 0
          ? { logKey: 'bisect.first',  effective: true }
          : { logKey: 'bisect.second', effective: false };
      },
    },
    {
      id: 'C_DIFF', name: '比对变更', category: 'diagnose',
      timeCost: 2, staminaCost: 1, maxUses: 1,
      cardDesc: '出事了先看最近改了什么。这是本能。',
      detail: '检查最近 24 小时的所有发布与配置变更。',
      effect: function () {
        return { logKey: 'diff.none', gainedEvidence: ['E4'], effective: true };
      },
    },
    {
      id: 'C_UPSTREAM', name: '查看上游调用', category: 'diagnose',
      timeCost: 2, staminaCost: 1, maxUses: 1,
      cardDesc: '看看是谁在反复敲门。',
      detail: '需要先做链路追踪。',
      requires: function (s) { return s.evidence.has('E3'); },
      effect: function (s) {
        s.rootCauseConfirmed = true;
        return { logKey: 'upstream.retry', gainedEvidence: ['E5'], effective: true, celebrate: true };
      },
    },

    /* ── 缓解类 ── */
    {
      id: 'C_RATELIMIT', name: '限流', category: 'mitigate',
      timeCost: 1, staminaCost: 1, maxUses: 1,
      cardDesc: '先让它慢下来，别让数据库被打死。',
      detail: '故障增速降低一半，但部分用户会被拒绝。',
      effect: function (s) {
        if (s.mitigationFactor <= 0.5) return { logKey: 'ratelimit.repeat', effective: false };
        var before = DATA_SEVERITY(s, s.timeElapsed);
        s.mitigationFactor = 0.5;
        var after = DATA_SEVERITY(s, s.timeElapsed);
        s.ratelimitOn = true;
        return { logKey: 'ratelimit.on', effective: true, data: { before: before, after: after } };
      },
    },
    {
      id: 'C_SCALE', name: '扩容', category: 'mitigate', trap: true,
      timeCost: 3, staminaCost: 2, maxUses: 2,
      cardDesc: '不够就加机器。最直觉的反应。',
      detail: '增加服务实例数量。',
      effect: function () {
        return { logKey: 'scale.useless', effective: false, zhao: 'zhao_after_scale' };
      },
    },
    {
      id: 'C_RESTART', name: '重启服务', category: 'mitigate', trap: true,
      timeCost: 1, staminaCost: 1, maxUses: Infinity,
      cardDesc: '一分钟，影响值归零。',
      detail: '⚠ 重启会清空当前服务的运行时状态。',
      effect: function (s) {
        var before = s.impact;
        var first = s.restartCount === 0;
        onRestart(s, before);
        return {
          logKey: first ? 'restart.first' : 'restart.repeat',
          effective: false,
          zhao: first ? 'zhao_after_restart' : null,
        };
      },
    },

    /* ── 修复类 ── */
    {
      id: 'C_CACHE', name: '加缓存', category: 'fix', trap: true,
      timeCost: 4, staminaCost: 2, maxUses: 1,
      cardDesc: '读得太慢？加一层缓存。',
      detail: '在订单服务前面加一层缓存。',
      effect: function () {
        return { logKey: 'fix.wrongTarget.cache', effective: false };
      },
    },
    {
      id: 'C_INDEX', name: '加索引', category: 'fix', trap: true,
      timeCost: 5, staminaCost: 2, maxUses: 1,
      cardDesc: '慢查询？加个索引就好了。',
      detail: '给订单表加一个查询索引。',
      effect: function () {
        return { logKey: 'fix.wrongTarget.index', effective: false };
      },
    },
    {
      id: 'C_DEPLOY', name: '改代码 + 发版', category: 'fix',
      timeCost: 8, staminaCost: 3, maxUses: 1,
      cardDesc: '真正的修复。也是真正的贵。',
      detail: '加幂等键，改订单创建逻辑，走完整发版流程。需要先确认根因。',
      requires: function (s) { return s.rootCauseConfirmed; },
      effect: function (s) {
        s.rootCauseFixed = true;
        return { logKey: 'deploy.success', effective: true };
      },
    },

    /* ── 沟通类 ★ ── */
    {
      id: 'C_SYNC', name: '同步进展', category: 'communicate',
      timeCost: 1, staminaCost: 1, maxUses: Infinity,
      cardDesc: '告诉他们你在做什么。这很重要。',
      detail: '向管理层同步当前进展，争取更多时间。剩余时间 +10 分钟。前 3 次有效。',
      effect: function (s) {
        if (s.syncCount >= CONFIG.syncLimit) {
          s.syncCount += 1;
          return { logKey: 'sync.exhausted', effective: false };
        }
        s.syncCount += 1;
        s.timeLimit += CONFIG.syncBonus;
        return { logKey: 'sync.' + s.syncCount, effective: true, data: { bonus: CONFIG.syncBonus } };
      },
    },
    {
      id: 'C_ESCALATE', name: '向上汇报', category: 'communicate',
      timeCost: 2, staminaCost: 1, maxUses: Infinity,
      cardDesc: '提前跟老板说清楚，别让他来插手。',
      detail: '主动汇报，避免管理层在调查中途强制干预。只生效 1 次。',
      effect: function (s) {
        if (s.rootCauseConfirmed && !s.escalationBlocked) {
          // §8 宽松处理：已确认根因时打出，返回文案但不消耗生效次数
          return { logKey: 'escalate.afterRoot', effective: false, noConsume: true };
        }
        if (s.escalateUsedCount >= CONFIG.escalateLimit) {
          return { logKey: 'escalate.exhausted', effective: false };
        }
        s.escalateUsedCount += 1;
        s.escalationBlocked = true;
        return { logKey: 'escalate.success', effective: true };
      },
    },

    /* ── 视界 ── */
    {
      id: 'C_VISION', name: '开启视界', category: 'vision',
      timeCost: 0, staminaCost: 0, maxUses: Infinity,
      cardDesc: '你在等什么。',
      detail: '消耗 1 点视界带宽，直接看清根因所在。需要至少 2 条已掌握的线索。',
      /* ⚠ 前置用 `evidenceEver`（曾经看到过的线索，重启不会清空）而非 `evidence`（现场证据）。
       * 依据：§4.3 明确要求「重启封死了所有常规诊断路径，但没封死视界」——
       *   若用 `evidence`，重启后它会归零，视界将永远不可用，§9 验收第 5 条随之失效。
       * 语义上也更对：视界是程叙自己的能力，日志被重启冲掉，他看过的东西不会。
       * 详见 README「与规格的偏差」偏差 3。 */
      requires: function (s) { return s.evidenceEver.size >= 2 && !s.visionDisabled; },
      effect: function (s) {
        if (s.visionBandwidth <= 0) {
          s.overclocked = true;
          s.visionDisabled = true;
          s.rootCauseConfirmed = true;
          s.overclockTurnsLeft = CONFIG.overclockTurns;
          return { logKey: 'vision.overclock', effective: true, celebrate: true, overclock: true };
        }
        s.visionBandwidth -= 1;
        s.rootCauseConfirmed = true;
        s.visionUsed += 1;
        return {
          logKey: 'vision.reveal', effective: true, celebrate: true,
          data: { left: s.visionBandwidth },
        };
      },
    },
  ];

  /* 需要在 data.js 内部引用引擎的严重度函数（限流卡反馈要显示前后增速）。
     用一个「后置注入」的占位，由 engine.js 在加载时填上，避免循环依赖。 */
  var DATA_SEVERITY = function () { return 0; };
  function _injectSeverity(fn) { DATA_SEVERITY = fn; }

  /* 重启副作用 §4.3 —— 放在 data.js 因为重启卡要用 */
  function onRestart(s, impactBefore) {
    s.impact = 0;
    s.evidence.clear();
    s.rootCauseConfirmed = false;
    s.evidenceLost = true;
    s.phaseBonus += CONFIG.restartPhaseBonus;
    s.restartCount += 1;
    s.lastRestartImpactBefore = impactBefore;
    // mitigationFactor 保留（限流等策略仍在生效）
  }

  /* 强制接管事件的「重启」§6.2 —— 与玩家主动重启不同
   * ⚠ 规格 §6.2 括号写「同时执行 onRestart() 逻辑」。若照做，Impact 归零、
   *   phaseBonus +0.5，则以下四处带具体数字的产物全部失效：
   *     §3.3 被动失败曲线（15 分 → 64.50）
   *     §9-1 验收项（不做操作，15 分钟 Impact ≈ 64.50）
   *     §10 路径 D（逐回合表，15 分 → 64.50）
   *     07 §5.2 F 级结算样例（15 分 → 64.5 / 2064 人）
   *   且从设计上说不通：Impact 是本作的失败线，「惩罚事件」把它归零等于发奖励。
   *   07 §4.2 的原话也已给出正确语义：**「它不直接扣分，但它毁掉了证据链。」**
   *   → 故本实现取「只毁证据链，不改数值」，判定 §6.2 括号内说明为笔误。
   *   详见 README「与规格的偏差」。
   */
  function onForcedRestart(s) {
    s.evidence.clear();
    s.rootCauseConfirmed = false;
    s.evidenceLost = true;
    // 刻意不动：impact / phaseBonus / restartCount
  }

  var CARD_BY_ID = {};
  CARDS.forEach(function (c) { CARD_BY_ID[c.id] = c; });

  var CATEGORY_LABEL = {
    observe: '观测', diagnose: '诊断', mitigate: '缓解',
    fix: '修复', communicate: '沟通', vision: '视界',
  };
  var CATEGORY_ORDER = ['observe', 'diagnose', 'mitigate', 'fix', 'communicate', 'vision'];

  return {
    CONFIG: CONFIG,
    PHASES: PHASES,
    EVIDENCES: EVIDENCES,
    CARDS: CARDS,
    CARD_BY_ID: CARD_BY_ID,
    CATEGORY_LABEL: CATEGORY_LABEL,
    CATEGORY_ORDER: CATEGORY_ORDER,
    onRestart: onRestart,
    onForcedRestart: onForcedRestart,
    _injectSeverity: _injectSeverity,
  };
});
