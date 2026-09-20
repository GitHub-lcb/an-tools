/* ============================================================================
 * ui.js — 渲染与交互层
 * 唯一职责：把 engine 的状态画出来、把点击翻译成 playCard / skipTurn。
 * 所有玩家可见文本一律取自 texts.js（T），本文件不硬编码文案。
 * ========================================================================== */
(function () {
  'use strict';

  var E = window.CVEngine, D = window.CVData, T = window.CVTexts;
  var $ = function (id) { return document.getElementById(id); };

  var state = null;
  var busy = false;

  /* ── 模板填充 ───────────────────────────────────────────────────────────── */
  function tpl(str, data) {
    if (str == null) return '';
    if (!data) return str;
    return String(str).replace(/\{(\w+)\}/g, function (m, k) {
      return (data[k] !== undefined && data[k] !== null) ? data[k] : m;
    });
  }
  function clock(t) {
    var m = 9 * 60 + 7 + Math.round(t);
    var hh = Math.floor(m / 60) % 24, mm = m % 60;
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function impactColor(ratio) {
    var hue = ratio < 0.5
      ? 186 + (38 - 186) * (ratio / 0.5)
      : 38 + (4 - 38) * ((ratio - 0.5) / 0.5);
    return 'hsl(' + hue.toFixed(0) + ', 84%, 56%)';
  }

  /* ── 开场 ───────────────────────────────────────────────────────────────── */
  function showIntro() {
    var host = $('overlay-host');
    host.innerHTML =
      '<div class="overlay"><div class="modal intro">' +
        '<div class="sky">' + T.ui.subtitle + '</div>' +
        '<div class="lines">' +
          T.ui.intro.map(function (l) { return '<p>' + l + '</p>'; }).join('') +
        '</div>' +
        '<button class="go" id="btn-go">开始处置</button>' +
        '<div class="meta">' +
          '每一回合打出一张卡。时间是本关唯一不可再生的资源。<br>' +
          '时限耗尽、影响值破线、或触发数据事故，都会直接结束。<br>' +
          '没有教程。所有规则都在你手上的卡里。' +
        '</div>' +
      '</div></div>';
    $('btn-go').onclick = start;
  }

  function start() {
    $('overlay-host').innerHTML = '';
    $('zhao-host').innerHTML = '';
    state = E.createState();
    busy = false;
    $('app').classList.remove('hidden');
    $('log').innerHTML = '';
    showZhao('zhao_open');
    renderAll();
    // 第一回合的免费信息：把「你现在能看到什么」摆出来
    appendAndRender({ kind: 'aside', logKey: 'intro.hint' });
  }

  /* ── 老赵弹窗 ───────────────────────────────────────────────────────────── */
  var zhaoTimer = null;
  function showZhao(key) {
    var lines = T.zhao[key];
    if (!lines) return;
    var host = $('zhao-host');
    host.innerHTML =
      '<div class="zhao"><div class="who">老赵</div>' +
      lines.map(function (l) { return '<div class="line">' + l + '</div>'; }).join('') +
      '</div>';
    if (zhaoTimer) clearTimeout(zhaoTimer);
    zhaoTimer = setTimeout(function () { host.innerHTML = ''; }, 5200);
  }

  /* ── 状态栏 ─────────────────────────────────────────────────────────────── */
  function renderStatusbar() {
    var out = [];
    if (state.ratelimitOn) out.push('<span class="warn amber">' + T.ui.warnRatelimit + '</span>');
    if (state.evidenceLost) out.push('<span class="warn red">' + T.ui.warnEvidenceLost + '</span>');
    if (state.visionDisabled && state.overclocked) out.push('<span class="warn red">' + T.ui.warnOverclock + '</span>');
    if (!out.length) out.push('<span class="warn cyan">○ 全链路正常采集</span>');
    $('statusbar').innerHTML = out.join('');
  }

  /* ── 左栏 ───────────────────────────────────────────────────────────────── */
  function renderMeters() {
    var ir = Math.min(1, state.impact / D.CONFIG.impactThreshold);
    var c = impactColor(ir);
    $('v-impact').textContent = state.impact.toFixed(1);
    $('bar-impact').style.width = (ir * 100) + '%';
    $('bar-impact').style.background = c;

    $('v-time').textContent = state.timeElapsed.toFixed(0);
    $('v-limit').textContent = state.timeLimit;
    var tr = Math.min(1, state.timeElapsed / state.timeLimit);
    $('bar-time').style.width = (tr * 100) + '%';
    $('bar-time').style.background = tr > 0.8 ? 'var(--red)' : 'var(--cyan)';

    $('v-stamina').textContent = state.teamStamina + ' / ' + state.teamStaminaMax;
    $('bar-stamina').style.width = (state.teamStamina / state.teamStaminaMax * 100) + '%';

    $('v-vision').textContent = state.visionBandwidth;
    var pips = '';
    for (var i = 0; i < D.CONFIG.initialVision; i++) {
      pips += '<span class="pip' + (i < state.visionBandwidth ? ' on' : '') + '"></span>';
    }
    $('pips-vision').innerHTML = pips;

    $('v-evcount').textContent = state.evidence.size;

    var ph = E.phaseAt(state, state.timeElapsed);
    $('pill-phase').textContent = '阶段 · ' + ph.id + ' ' + ph.name;
    $('pill-clock').textContent = clock(state.timeElapsed);
    $('turn-hint').textContent = '第 ' + state.turnIndex + ' 回合';
  }

  function renderEvidence() {
    var host = $('evidence');
    if (!state.evidence.size) {
      host.innerHTML = '<div class="ev empty">' + T.ui.evidenceEmpty + '</div>';
      return;
    }
    var order = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'];
    host.innerHTML = order.filter(function (k) { return state.evidence.has(k); }).map(function (k) {
      var ev = D.EVIDENCES[k];
      var big = (k === 'E5' || k === 'E3');
      return '<div class="ev' + (big ? ' big' : '') + '">' +
             '<span class="eid">' + ev.id + '</span>' +
             '<span class="etxt">' + ev.label + '</span></div>';
    }).join('');
  }

  /* ── 右栏：卡池 ─────────────────────────────────────────────────────────── */
  function costText(card) {
    var t = E.effectiveTimeCost(state, card);
    var fast = t !== card.timeCost;
    return '<span class="c">' +
      (t === 0 ? '0 分钟' : t + ' 分钟' + (fast ? ' ⚡' : '')) +
      ' · ' + card.staminaCost + ' 精力' +
      (card.maxUses && card.maxUses !== Infinity ? ' · 限 ' + card.maxUses + ' 次' : '') +
      '</span>';
  }
  function disabledReason(card) {
    var lg = E.checkLegality(state, card);
    if (lg.ok) return null;
    if (lg.reason === 'stamina') return T.ui.disabledStamina;
    if (lg.reason === 'requires') {
      if (card.id === 'C_VISION') return T.ui.disabledRequires;
      return T.ui.disabledRequires;
    }
    if (lg.reason === 'maxuses') return T.ui.disabledMaxuses;
    return '';
  }

  function renderCards() {
    var host = $('cards');
    var html = '';
    D.CATEGORY_ORDER.forEach(function (cat) {
      var list = D.CARDS.filter(function (c) { return c.category === cat; });
      if (!list.length) return;
      html += '<div class="cat"><div class="catname">' + D.CATEGORY_LABEL[cat] + '</div>';
      list.forEach(function (card) {
        var lg = E.checkLegality(state, card);
        var dis = !lg.ok;
        var title = dis ? disabledReason(card) : card.detail;
        var cls = 'card' + (card.category === 'vision' ? ' vision' : '') + (card.trap ? ' trap' : '');
        html += '<button class="' + cls + '" data-card="' + card.id + '"' +
                (dis ? ' disabled' : '') + ' title="' + title.replace(/"/g, '&quot;') + '">' +
                  '<span class="cn"><span class="t">' + card.name + '</span>' + costText(card) + '</span>' +
                  '<span class="cd">' + card.cardDesc + '</span>' +
                '</button>';
      });
      html += '</div>';
    });
    html += '<button class="skipbtn" id="btn-skip">' + T.ui.skip +
            '<small>' + T.ui.skipHint + '</small></button>';
    host.innerHTML = html;

    host.querySelectorAll('[data-card]').forEach(function (btn) {
      btn.addEventListener('click', function () { onCard(btn.getAttribute('data-card')); });
    });
    $('btn-skip').addEventListener('click', onSkip);
  }

  /* ── 中栏：处置记录 ─────────────────────────────────────────────────────── */
  function entryText(en) {
    if (en.logKey && T.log[en.logKey] !== undefined) {
      var data = en.data || {};
      if (en.logKey === 'monitor.dashboard') {
        data = {
          impact: state.impact.toFixed(1),
          severity: E.severityAt(state, state.timeElapsed).toFixed(1),
          remaining: (state.timeLimit - state.timeElapsed).toFixed(0),
        };
      } else if (en.logKey === 'restart.first') {
        data = { before: (en.impactBefore || 0).toFixed(1) };
      } else if (en.logKey === 'restart.repeat') {
        data = { n: en.restartCount };
      } else if (en.logKey === 'event.p3') {
        data = en.data || E.eventData(state);
      }
      return tpl(T.log[en.logKey], data);
    }
    if (en.logKey && T.event[en.logKey] !== undefined) {
      var d2 = en.data || (en.logKey === 'event.p3' ? E.eventData(state) : {});
      return tpl(T.event[en.logKey], d2);
    }
    if (en.logKey && T.review[en.logKey] !== undefined) return T.review[en.logKey];
    return en.text || '';
  }

  function entryHtml(en) {
    switch (en.kind) {
      case 'card': {
        var card = D.CARD_BY_ID[en.cardId];
        var cls = en.celebrate ? ' strong' : '';
        var out = '<div class="entry' + cls + '">' +
          '<div class="head"><span class="name">' + (card ? card.name : en.cardId) + '</span>' +
          '<span class="tag">' + (card ? D.CATEGORY_LABEL[card.category] : '') + '</span>' +
          '<span class="cost">+' + en.cost + ' 分钟</span></div>' +
          '<pre class="body">' + escapeHtml(entryText(en)) + '</pre>';
        if (en.celebrate) {
          out += '<div class="celebrate">' +
            (en.overclock ? T.banner.rootCauseExact : T.banner.rootCause) + '</div>';
        }
        return out + '</div>';
      }
      case 'event': {
        var danger = en.logKey === 'event.forced_restart';
        return '<div class="entry event">' +
          '<div class="head"><span class="name">' + (danger ? '生产事件' : '系统事件') + '</span></div>' +
          '<pre class="body' + (danger ? ' danger' : '') + '">' + escapeHtml(entryText(en)) + '</pre>' +
          '</div>';
      }
      case 'restart':
        return '<div class="entry">' +
          '<div class="head"><span class="name">重启服务</span>' +
          '<span class="tag">缓解</span><span class="cost">+' + en.cost + ' 分钟</span></div>' +
          '<pre class="body">' + escapeHtml(entryText(en)) + '</pre></div>';
      case 'skip':
        return '<div class="entry skip"><pre class="body">' + escapeHtml(entryText(en)) + '</pre></div>';
      case 'aside':
        return '<div class="entry aside"><pre class="body">' + escapeHtml(entryText(en)) + '</pre></div>';
      case 'zhao': {
        var lines = T.zhao[en.key] || [];
        return '<div class="entry aside"><pre class="body">老赵：' +
          escapeHtml(lines.join(' ')) + '</pre></div>';
      }
      default:
        return '';
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderLog() {
    var host = $('log');
    host.innerHTML = state.entries.map(entryHtml).join('');
    host.scrollTop = host.scrollHeight;
  }

  function appendAndRender(en) {
    state.entries.push(en);
    renderLog();
  }

  /* ── 渲染总入口 ─────────────────────────────────────────────────────────── */
  function renderAll() { renderStatusbar(); renderMeters(); renderEvidence(); renderCards(); renderLog(); }

  /* ── 交互 ───────────────────────────────────────────────────────────────── */
  var onCard = function (cardId) {
    if (busy || !state || state.result !== 'ongoing') return;
    var card = D.CARD_BY_ID[cardId];
    var cost = E.effectiveTimeCost(state, card);
    var lg = E.checkLegality(state, card);

    if (lg.confirm === 'overclock') { askOverclock(cardId); return; }

    var before = state.entries.length;
    var res = E.playCard(state, cardId);
    if (!res.ok) return;
    // 给新条目补上本回合的时间成本，供记录头部显示
    for (var i = before; i < state.entries.length; i++) {
      if (state.entries[i].cost === undefined) state.entries[i].cost = cost;
    }
    afterAction();
  };

  var onSkip = function () {
    if (busy || !state || state.result !== 'ongoing') return;
    var before = state.entries.length;
    var res = E.skipTurn(state);
    if (!res.ok) return;
    for (var i = before; i < state.entries.length; i++) {
      if (state.entries[i].cost === undefined) state.entries[i].cost = 1;
    }
    afterAction();
  };

  function afterAction() {
    renderAll();
    // 老赵弹窗
    var lastZhao = null;
    state.entries.slice().reverse().some(function (e) {
      if (e.kind === 'zhao') { lastZhao = e; return true; }
      return false;
    });
    if (lastZhao && !lastZhao._shown) { lastZhao._shown = true; showZhao(lastZhao.key); }

    // 重启首用的 3 秒后追加（07 §2.10：不弹窗、不加音效，就静静地出现）
    var restartFirst = state.entries.slice().reverse().find(function (e) {
      return e.kind === 'restart' && e.logKey === 'restart.first';
    });
    if (restartFirst && !restartFirst._aside) {
      restartFirst._aside = true;
      setTimeout(function () {
        if (!state) return;
        appendAndRender({ kind: 'aside', logKey: 'restart.after3s' });
      }, 3000);
    }

    if (state.result !== 'ongoing') {
      setTimeout(function () { showSettle(); }, 620);
    }
  }

  /* ── 超频确认（全游戏唯一的确认框，§8）──────────────────────────────────── */
  function askOverclock(cardId) {
    var host = $('overlay-host');
    host.innerHTML =
      '<div class="overlay"><div class="modal">' +
        '<div class="review-title">视界 · 超频</div>' +
        '<div class="review" style="font-size:14px">你的带宽已经用完了。\n\n' +
        '你可以强行再看一次。\n\n代价：\n  · 本场剩余时间，无法再开启视界\n  · 最终评级下降一级\n\n' +
        '鼻血会流下来。\n这一次，会流得比上次多。</div>' +
        '<div class="actions">' +
          '<button class="primary" id="oc-yes">强行开启</button>' +
          '<button id="oc-no">算了</button>' +
        '</div></div></div>';
    $('oc-no').onclick = function () { host.innerHTML = ''; };
    $('oc-yes').onclick = function () {
      host.innerHTML = '';
      var before = state.entries.length;
      var cost = E.effectiveTimeCost(state, D.CARD_BY_ID[cardId]);
      var res = E.playCard(state, cardId, { forceOverclock: true });
      if (!res.ok) return;
      for (var i = before; i < state.entries.length; i++) {
        if (state.entries[i].cost === undefined) state.entries[i].cost = cost;
      }
      afterAction();
    };
  }

  /* ── 结算 ───────────────────────────────────────────────────────────────── */
  function wasteList(s) {
    var lines = [];
    D.CARDS.filter(function (c) { return c.trap; }).forEach(function (c) {
      var n = state.usedCards.get(c.id) || 0;
      if (!n) return;
      lines.push('  ' + pad(c.name, 12) + (c.timeCost * n) + ' 分钟    → ' +
        (c.id === 'C_HISTORY' ? '信息有价值，但对解决无帮助' : '无效'));
    });
    return lines.join('\n');
  }
  function pad(s, n) {
    var w = 0, out = '';
    for (var i = 0; i < s.length; i++) { out += s[i]; w += /[\u4e00-\u9fa5]/.test(s[i]) ? 2 : 1; }
    while (w < n) { out += ' '; w++; }
    return out;
  }

  function rankNote(s) {
    var order = ['S', 'A', 'B', 'C', 'D'];
    var lines = [];
    var afterCap = s.rankRaw;
    if (!afterCap) return lines;
    if (s.restartCount > 0 && order.indexOf(s.rankRaw) < order.indexOf('B')) {
      afterCap = 'B';
      lines.push('  影响值 ' + s.impact.toFixed(1) + '  →  本应评为 ' + s.rankRaw);
      lines.push('  重启次数 ' + s.restartCount + '  →  评级封顶为 B');
    }
    if (s.overclocked) {
      var demoted = order[Math.min(order.indexOf(afterCap) + 1, order.length - 1)];
      lines.push('  影响值 ' + s.impact.toFixed(1) + '  →  本应评为 ' + afterCap);
      lines.push('  视界超频  →  评级降为 ' + demoted);
    }
    if (s.restartCount > 0 && s.overclocked) lines.push('  （两项均适用）');
    return lines;
  }

  function reviewFor(s) {
    if (s.result === 'win_root') return T.review[s.rank] || T.review.A;
    if (s.result === 'lose_timeout') {
      return tpl(T.review.F_TIMEOUT, { wasteList: wasteList(s), idle: s.wasted });
    }
    if (s.result === 'lose_impact') return T.review.F_IMPACT;
    if (s.result === 'lose_data') return T.review.F_DATA;
    return '';
  }
  function resultTitle(s) {
    if (s.result === 'win_root') return '根因已消除';
    if (s.result === 'win_mitigated') return '已止血 · 根因未消除';
    if (s.result === 'lose_timeout') return T.review.TITLE_TIMEOUT;
    if (s.result === 'lose_impact') return T.review.TITLE_IMPACT;
    if (s.result === 'lose_data') return T.review.TITLE_DATA;
    return '';
  }

  function showSettle() {
    var s = E.settle(state);
    var sugg = E.suggestions(state, s).map(function (k) {
      return '<p>' + tpl(T.suggest[k], { wasted: s.wasted, total: s.total, effective: s.effective }) + '</p>';
    }).join('');
    var note = rankNote(s);
    var zhaoKey = s.result === 'win_root' ? 'zhao_on_win_root'
                : s.result === 'win_mitigated' ? 'zhao_on_win_mitigated' : 'zhao_on_lose';
    var zhaoLines = T.zhao[zhaoKey] || [];

    var visionTxt = s.visionUsed + ' 次' + (s.overclocked ? '（含超频）' : '');

    $('overlay-host').innerHTML =
      '<div class="overlay"><div class="modal">' +
        '<div class="rank-head">' +
          '<div class="cap">' + T.settle.title + '</div>' +
          '<div class="rk ' + s.rank + '">' + s.rank + '</div>' +
          '<div class="rs">' + resultTitle(s) + '</div>' +
        '</div>' +

        '<div class="statgrid">' +
          st(T.settle.time, s.timeElapsed.toFixed(0) + ' / ' + s.timeLimit, T.settle.minutes) +
          st(T.settle.impact, s.impact.toFixed(1), '/ 100') +
          st(T.settle.users, s.users, T.settle.people) +
          st(T.settle.orders, s.orders, T.settle.ordersUnit) +
          st(T.settle.restart, s.restartCount, T.settle.times) +
          st(T.settle.vision, visionTxt, '') +
          st(T.settle.effective, s.effective + ' / ' + s.total, '') +
          st(T.settle.wasted, s.wasted, T.settle.minutes) +
        '</div>' +

        (note.length
          ? '<div class="block"><div class="bt">' + T.settle.rankNoteTitle + '</div>' + note.join('<br>') + '</div>'
          : '') +

        '<div class="zhao-inline"><div class="who">老赵</div>' +
          zhaoLines.map(function (l) { return '<p>' + l + '</p>'; }).join('') +
        '</div>' +

        '<div class="review-title">' + T.settle.reviewTitle + '</div>' +
        '<div class="review">' + escapeHtml(reviewFor(s)) + '</div>' +
        (sugg ? '<div class="sugg">' + sugg + '</div>' : '') +

        '<div class="actions">' +
          '<button id="btn-again">' + T.settle.again + '</button>' +
          '<button class="primary" id="btn-cont">' + T.settle.cont + '</button>' +
        '</div>' +
      '</div></div>';

    $('btn-again').onclick = start;
    $('btn-cont').onclick = function () {
      if (s.result === 'win_root') showUnlock();
      else $('overlay-host').innerHTML = '';
    };
  }

  function st(k, v, unit) {
    return '<div class="st"><div class="k">' + k + '</div>' +
           '<div class="v">' + v + (unit ? ' <small>' + unit + '</small>' : '') + '</div></div>';
  }

  function showUnlock() {
    $('overlay-host').innerHTML =
      '<div class="overlay"><div class="modal"><div class="unlock">' +
        '<p class="hi">' + T.unlock[0] + '</p>' +
        '<div class="stamp">' + T.unlock[1] + ' 　 重复订单：0</div>' +
        '<div style="height:14px"></div>' +
        T.unlock.slice(4).map(function (l, i) {
          return '<p' + (i >= 4 ? ' class="hi"' : '') + '>' + l + '</p>';
        }).join('') +
        '<div class="actions"><button class="primary" id="btn-end">' + T.settle.pending + '</button></div>' +
      '</div></div></div>';
    $('btn-end').onclick = function () { $('overlay-host').innerHTML = ''; };
  }

  /* ── 主题 ───────────────────────────────────────────────────────────────── */
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('cv-theme'); } catch (e) {}
    if (saved === 'light') document.body.classList.add('light');
    $('btn-theme').onclick = function () {
      document.body.classList.toggle('light');
      try { localStorage.setItem('cv-theme', document.body.classList.contains('light') ? 'light' : 'dark'); } catch (e) {}
    };
  }

  /* ── 启动 ───────────────────────────────────────────────────────────────── */
  $('btn-restart').onclick = function () { $('overlay-host').innerHTML = ''; start(); };
  initTheme();
  showIntro();

  // 供控制台调试 / 自动化用
  window.cvGame = {
    getState: function () { return state; },
    play: onCard,
    skip: onSkip,
  };
})();
