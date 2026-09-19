# LEVEL 2《决堤》· 实现规格（程序向）

> **文档用途**：程序可直接依据本文档实现灰盒原型，无需额外提问。
> **配套文档**：`10-LEVEL2-文案全集.md`、`11-LEVEL2-数值表与平衡模型.md`、`06-LEVEL1-实现规格.md`（共用机制）
> **前置**：LEVEL 1 已完成。本文档**只描述差异**，未提及的部分沿用 `06`。

---

## 0. 设计目标与变更

### 0.1 LEVEL 2 要验证什么

LEVEL 1 只验证了「诊断 → 权衡 → 后果」的基本循环。有四个机制 LEVEL 1 结构上无法测试：

| 新机制 | 为什么 LEVEL 1 测不了 |
|---|---|
| **双失败线**（Impact + 数据库健康度） | LEVEL 1 只有一条失败线 |
| **扩容是反向操作** | LEVEL 1 里扩容只是"浪费时间"，不会让情况变糟 |
| **止血通关**（C / D 评级） | LEVEL 1 的缓解系数最低只能到 0.5，无法达成止血 |
| **复发机制**（治标不治本会反弹） | LEVEL 1 没有"临时修复会失效"的概念 |

**核心设计意图**：

> LEVEL 1 的教训是「**时间会用完**」。
> LEVEL 2 的教训是「**你救错地方，会死得更快**」。

### 0.2 相对 LEVEL 1 的关键差异

| 项 | LEVEL 1 | LEVEL 2 | 理由 |
|---|---|---|---|
| 失败线 | Impact ≥ 100 | Impact ≥ 200 **或** DB Health ≤ 0 | 引入不可逆的系统崩溃 |
| 主要死因 | 时限耗尽 | **数据库被打挂** | 玩家必须学会"保护最脆弱的一环" |
| 缓解叠加 | 仅限流 | 限流 × 降级 × 熔断 | 让"止血通关"成为可能 |
| 扩容 | 无效（浪费 3 分钟） | **反向（加速崩溃）** | 从"浪费时间"升级为"主动作恶" |
| 重启 | 清空 Impact，但毁证据 | **不清空 Impact，且制造惊群** | 教会玩家"不是所有故障都能重启解决" |
| 时限 | 15 分钟 | 40 分钟 | 关卡更长，容错更高，但压力更复杂 |
| 视界带宽 | 3 | 3 | 不变 |

---

## 1. 数据结构

### 1.1 LEVEL 2 扩展字段

在 `IncidentState`（见 `06` §1.1）基础上新增：

```typescript
interface IncidentStateL2 extends IncidentState {
  // ── 数据库 ──
  dbHealth: number;           // 100 → 0。<= 0 触发数据事件
  poolUsage: number;          // 当前连接池占用，0–50。每回合重算

  // ── 缓存 ──
  cacheHitRate: number;       // 初值 0.12（雪崩后）
  preheatAt: number | null;   // 预热缓存的时刻，用于复发判定
  preheatExpired: boolean;    // 预热是否已失效

  // ── 缓解 ──
  scaleCount: number;         // 扩容次数，初值 0。每次 effectiveLoad × 1.3
  degraded: boolean;          // 是否已降级
  tripped: boolean;           // 是否已熔断（severity 归零，不可逆）

  // ── 沟通 ──
  opsJoined: boolean;         // 大促运营是否已进群
}
```

### 1.2 常量

| 常量 | 值 |
|---|---|
| `SEVERITY_BASE` | **3.0** |
| `IMPACT_THRESHOLD` | **200** |
| `INITIAL_TIME_LIMIT` | **40** |
| `DB_HEALTH_MAX` | **100** |
| `POOL_MAX` | **50** |
| `CACHE_HIT_INITIAL` | **0.12** |
| `CACHE_HIT_PREHEATED` | **0.85** |
| `PREHEAT_LIFESPAN` | **15 分钟** |
| `SCALE_LOAD_MULT` | **1.3**（每次扩容累乘） |
| `SCALE_DRAIN_MULT` | **1.5**（扩容期间，DB 掉血 ×1.5） |
| `TRIP_LUMP_IMPACT` | **50**（熔断的一次性影响） |

---

## 2. 回合流程（差异部分）

### 2.1 结算顺序

LEVEL 2 每回合需要结算**三个量**，且顺序不可颠倒：

```javascript
function playTurnL2(state, cardId) {
  const card = CARDS[cardId];
  const legality = checkLegality(state, card);
  if (!legality.ok) return { ok: false, reason: legality.reason };

  // ── [1] 推进时间：按回合内的分段，同时结算 Impact 与 DB Health ──
  //     注意：DB 掉血速度依赖 dbHealth 自身（正反馈），
  //     因此必须与时间推进一起做微分式分段，不能事后补算。
  advanceTimeAndBothMeters(state, card.timeCost);

  // ── [2] 扣除资源 ──
  state.teamStamina -= card.staminaCost;

  // ── [3] 应用卡牌效果 ──
  applyCardEffect(state, card);

  // ── [4] 重算连接池（影响下一回合的掉血判定）──
  recomputePool(state);

  // ── [5] 检查预热复发 ──
  checkPreheatExpiry(state);

  // ── [6] 触发事件 ──
  firePhaseTriggers(state);
  fireDangerTriggers(state);   // 新增：DB Health 危险线

  // ── [7] 胜利判定（必须先于失败判定）──
  checkVictory(state);
  if (state.result !== 'ongoing') return { ok: true, result: state.result };

  // ── [8] 失败判定 ──
  checkFailure(state);
  if (state.result !== 'ongoing') return { ok: true, result: state.result };

  if (state.timeElapsed >= state.timeLimit) {
    state.result = 'lose_timeout';
    return { ok: true, result: state.result };
  }

  state.turnIndex++;
  return { ok: true, result: 'ongoing' };
}
```

### 2.2 双计量推进（核心实现）

**这是本关最容易实现错的地方。**

`dbHealth` 的下降速度依赖 `dbHealth` 自身（`drain = 2.5 + (100 - dbHealth) × 0.045`），这是一个**正反馈微分方程**。不能用"起点速度 × 时长"近似——误差会超过 15%。

```javascript
const PHASES_L2 = [
  { id: 'P1', start: 0,  end: 5,        mod: 1.0, load: 0.50 },
  { id: 'P2', start: 5,  end: 15,       mod: 1.3, load: 0.65 },
  { id: 'P3', start: 15, end: 30,       mod: 1.7, load: 0.80 },
  { id: 'P4', start: 30, end: Infinity, mod: 2.2, load: 1.00 },
];

function advanceTimeAndBothMeters(state, deltaMinutes) {
  const STEP = 0.05;                 // 积分步长，单位：分钟
  let remaining = deltaMinutes;
  let cursor = state.timeElapsed;

  while (remaining > 1e-9) {
    const p = phaseAt(state, cursor);              // 含 phaseBonus
    const slice = Math.min(remaining, p.end - cursor, STEP);

    // ── Impact ──
    state.impact += state.severityBase * p.mod * state.mitigationFactor * slice;

    // ── DB Health ──
    const pool = computePool(state, p.load);
    if (pool >= POOL_MAX) {
      const drain = (2.5 + (DB_HEALTH_MAX - state.dbHealth) * 0.045)
                  * (state.scaleCount > 0 ? SCALE_DRAIN_MULT : 1.0);
      state.dbHealth -= drain * slice;
    }

    cursor += slice;
    remaining -= slice;
  }

  state.timeElapsed = roundTo(cursor, 2);
  state.impact      = roundTo(state.impact, 2);
  state.dbHealth    = roundTo(Math.max(0, state.dbHealth), 2);
  recomputePool(state);
}
```

> **实现提示**：`STEP = 0.05` 意味着 1 分钟要迭代 20 次。40 分钟的关卡最多约 800 次迭代——性能完全可接受。
> 步长若放大到 0.5，`dbHealth` 的死亡时刻会偏晚约 1.2 分钟，足以让平衡失效。**不要改这个值。**

### 2.3 连接池计算

```javascript
function computePool(state, phaseLoad) {
  if (state.tripped) return 0;

  let load = phaseLoad * state.mitigationFactor;
  load *= Math.pow(SCALE_LOAD_MULT, state.scaleCount);
  if (state.restartCount > 0) load *= Math.pow(1.15, state.restartCount); // 惊群

  const raw = (1 - state.cacheHitRate) * 100 * load;
  return Math.min(POOL_MAX, Math.round(raw));
}
```

**连接池是"中间变量"**——玩家看不见它的公式，但能在大盘上看到占用率。它是**从"缓存失效"到"数据库崩溃"的传导路径**。

> **教学价值**：玩家会逐渐理解——**你不需要修好缓存，你只需要让连接池不满。**

---

## 3. 故障演化模型

### 3.1 三条曲线

| 量 | 驱动 | 玩家能否直接干预 |
|---|---|---|
| **Impact** | 时间 × 阶段倍率 × 缓解系数 | ✅ 通过缓解卡 |
| **连接池占用** | 缓存命中率 × 阶段负载 × 缓解 × 扩容 | ✅ 通过缓解/预热/扩容 |
| **DB Health** | 连接池是否打满（正反馈加速） | ⚠️ **只能间接**——通过让连接池不满 |

### 3.2 阶段表

| 阶段 | 区间（分） | severity 倍率 | 等效强度（无缓解） | 连接池负载系数 | 叙事 |
|---|---|---|---|---|---|
| **P1 峰值** | [0, 5) | 1.0 | **3.00** /分 | 0.50 | 大促零点，流量峰值 |
| **P2 穿透** | [5, 15) | 1.3 | **3.90** /分 | 0.65 | 缓存集体失效，请求穿透 |
| **P3 高压** | [15, 30) | 1.7 | **5.10** /分 | 0.80 | 数据库告警 |
| **P4 濒危** | [30, ∞) | 2.2 | **6.60** /分 | 1.00 | 数据库即将不可用 |

### 3.3 DB Health 掉血曲线

```
drain(h) = 2.5 + (100 - h) × 0.045          [连接池满时]
         × 1.5                              [扩容后]
```

**解析解**（用于校验，实现仍用数值积分）：

```
h(τ) = 155.56 - 55.56 × e^(0.045τ)          无扩容
h(τ) = 155.56 - 55.56 × e^(0.0675τ)         扩容后
```

| 情形 | 连接池打满时刻 | DB 死亡时刻 |
|---|---|---|
| 被动（无操作） | t = 5 | **t ≈ 27.9** |
| 使用扩容 | t = 0 | **t ≈ 15.3** |
| 使用限流 | 不打满 | 不死 |

**扩容让数据库提前约 12.6 分钟死亡。** 这是本关最重的一击。

> **注意**：若玩家在 t>0 时才扩容（例如第 3 分钟），死亡时刻相应顺延。路径 D 中扩容耗时 3 分钟，DB 实际死于 **t = 18.35**。

### 3.4 扩容的反向作用

扩容同时产生两个负面效果：

| 效果 | 实现 | 玩家感知 |
|---|---|---|
| 连接池更快打满 | `load × 1.3` | 大盘上占用率立刻跳升 |
| 数据库掉血更快 | `drain × 1.5` | DB Health 条下降明显加速 |

**为什么这是真实的**：应用实例扩容后，每个实例都持有自己的连接池配置，但数据库的总连接数上限是固定的。更多实例 = 更多并发连接请求 = 更快耗尽数据库的连接资源。

> **这是本关最重要的反直觉设计，必须原样实现。** 不要因为测试者抱怨就削弱它——**玩家在结算时看到"你扩了容，数据库因此提前 14 分钟死亡"，这一句话的价值超过任何教程。**

### 3.5 预热与复发

```javascript
function onPreheat(state) {
  state.cacheHitRate = CACHE_HIT_PREHEATED;   // 0.12 → 0.85
  state.preheatAt = state.timeElapsed;
  state.preheatExpired = false;
  recomputePool(state);
}

function checkPreheatExpiry(state) {
  if (state.preheatAt === null) return;
  if (state.preheatExpired) return;
  if (state.rootCauseFixed) return;           // 已根治，不会复发
  if (state.timeElapsed - state.preheatAt >= PREHEAT_LIFESPAN) {
    state.cacheHitRate = CACHE_HIT_INITIAL;   // 回到 0.12
    state.preheatExpired = true;
    recomputePool(state);
    pushLog(state, 'event.preheat_expired');
  }
}
```

**这是本关第二个核心教学点**：预热缓存是**治标**。它把命中率拉回来，但只要 TTL 仍然是统一的，15 分钟后同样的雪崩会再来一次。

> 玩家会经历一次"我以为我修好了 → 它又崩了"的完整循环。
> **这个挫败感是刻意的**——它是理解"治标 vs 治本"的唯一途径。

### 3.6 熔断

```javascript
function onTrip(state) {
  state.tripped = true;
  state.mitigationFactor = 0;       // severity 归零
  state.impact += TRIP_LUMP_IMPACT; // 一次性 50
  pushLog(state, 'trip.activated');
}
```

| 效果 | 代价 |
|---|---|
| `severity = 0` → **Impact 永久停止增长** | 一次性 `impact += 50` |
| 连接池归零 → **DB 不再掉血** | 用户无法下单（结算时显示具体人数） |
| 系统存活到时限结束 → **止血通关** | 评级封顶 **C** |

**熔断不可逆。** 使用后无法解除。

> **设计意图**：熔断是"壮士断腕"。它保证你能活下来，代价是你亲手关掉了业务。
> **结算时必须显示"因你的选择，X 名用户未能下单"**——不做评判，只报事实。

---

## 4. 证据链

### 4.1 依赖图

```
  看监控大盘 ──► E1（缓存命中率 95% → 12%，连接池 44/50）

  看日志 ──────► E2（数据库连接超时，获取连接等待 3200ms）

  查看缓存命中率 ──► E3（命中率曲线：23:58 前稳定 95%，00:00 断崖式下跌）
        │
        │ 需要 E3
        ▼
  检查过期时间配置 ──► E4 ★ 确认根因
                     （全部 key TTL = 3600s，且批量写入时刻集中在 22:58–23:02）

  ── 支线 ──
  比对变更 ────► E5（昨晚 23:00 有一次大促配置发布）
  链路追踪 ────► E6（请求全部穿透到数据库，无缓存命中）
```

### 4.2 根因确认

```javascript
function checkRootCauseL2(state) {
  if (state.evidence.has('E4')) state.rootCauseConfirmed = true;
  // 视界路径直接置位
}
```

**关键**：`比对变更`（E5）会指向"昨晚有发布"，这是一个**误导性线索**。玩家可能误以为是发布导致的故障，而去回滚——但回滚**不能解决问题**（TTL 配置是三个月前就写死的）。

> **这是刻意设计的假线索。** LEVEL 1 教了"出事先看变更"，LEVEL 2 就要教"变更不等于根因"。

---

## 5. 卡牌规格（差异与新卡）

### 5.1 卡牌总表（18 张）

| ID | 名称 | 类别 | 时间 | 精力 | 上限 | 相对 LEVEL 1 |
|---|---|---|---|---|---|---|
| `C_MONITOR` | 看监控大盘 | observe | 0 | 0 | ∞ | 扩展显示项 |
| `C_LOG` | 看日志 | observe | 1 | 0 | 2 | 内容不同 |
| `C_HITRATE` | **查看缓存命中率** | observe | 2 | 1 | 1 | **新** |
| `C_TRACE` | 链路追踪 | diagnose | 2 | 1 | ∞ | 保留 |
| `C_BISECT` | 二分定位 | diagnose | 3 | 1 | 2 | 保留 |
| `C_DIFF` | 比对变更 | diagnose | 2 | 1 | 1 | **改为假线索** |
| `C_TTL` | **检查过期时间配置** | diagnose | 2 | 1 | 1 | **新 · 正解前置** |
| `C_RATELIMIT` | 限流 | mitigate | 1 | 1 | 1 | 保留 |
| `C_DEGRADE` | **降级** | mitigate | 2 | 1 | 1 | **新** |
| `C_TRIP` | **熔断** | mitigate | 1 | 1 | 1 | **新 · 不可逆** |
| `C_PREHEAT` | **预热缓存** | mitigate | 4 | 2 | 1 | **新 · 会复发** |
| `C_SCALE` | 扩容 | mitigate | 3 | 2 | 2 | **改为反向** |
| `C_RESTART` | 重启服务 | mitigate | 1 | 1 | ∞ | **改为纯负面** |
| `C_DEPLOY` | 改代码 + 发版 | fix | 8 | 3 | 1 | **正解** |
| `C_ROLLBACK` | **回滚发布** | fix | 4 | 2 | 1 | **新 · 假修复** |
| `C_SYNC` | 同步进展 | communicate | 1 | 1 | 3 次 | 保留 |
| `C_ESCALATE` | 向上汇报 | communicate | 2 | 1 | 1 次 | 保留 |
| `C_OPS` | **拉大促运营进群** | communicate | 2 | 1 | 1 | **新** |
| `C_VISION` | 开启视界 | — | 0 | 0 | 带宽 3 | 保留 |

### 5.2 新增卡牌规格

#### `C_HITRATE` · 查看缓存命中率

```javascript
effect: () => ({ logKey: 'hitrate.drop', gainedEvidence: ['E3'], effective: true })
```

#### `C_TTL` · 检查过期时间配置 ★

```javascript
requires: (s) => s.evidence.has('E3'),
effect: (s) => {
  s.rootCauseConfirmed = true;
  return { logKey: 'ttl.uniform', gainedEvidence: ['E4'], effective: true };
}
```

**前置条件为 E3**：不知道命中率掉了，就不会想到去查 TTL 配置。

#### `C_DEGRADE` · 降级

```javascript
effect: (s) => {
  if (s.degraded) return { logKey: 'degrade.repeat', effective: false };
  s.degraded = true;
  s.mitigationFactor *= 0.6;
  return { logKey: 'degrade.on', effective: true };
}
```

关闭非核心功能（推荐位、评价、历史订单查询）。**与限流叠加**：`0.5 × 0.6 = 0.3`。

**副作用**：使用后常驻显示 `⚠ 部分功能已关闭`。结算计入受影响用户。

#### `C_TRIP` · 熔断

```javascript
requires: (s) => !s.tripped,
effect: (s) => {
  onTrip(s);
  return { logKey: 'trip.activated', effective: true };
}
```

**必须弹出确认框**（与 LEVEL 1 的超频同级），因为它不可逆且会直接终结本局。

#### `C_PREHEAT` · 预热缓存

```javascript
effect: (s) => {
  onPreheat(s);
  return { logKey: 'preheat.on', effective: true };
}
```

**这张卡表面上是全关最强的操作**——4 分钟让命中率回到 0.85，连接池立刻降到安全区。

**但 15 分钟后它会失效。** 如果那时还没根治，雪崩会重演。

#### `C_SCALE` · 扩容 ⚠️ 反向

```javascript
effect: (s) => {
  s.scaleCount += 1;
  recomputePool(s);
  return { logKey: 'scale.backfire', effective: false };
}
```

**永远不计为有效操作。**

#### `C_RESTART` · 重启服务 ⚠️ 纯负面

```javascript
effect: (s) => {
  s.restartCount += 1;
  s.evidence.clear();
  s.rootCauseConfirmed = false;
  s.evidenceLost = true;
  // 注意：不清空 impact，且不重置 phaseBonus（LEVEL 1 的机制在本关不适用）
  recomputePool(s);   // 惊群：load × 1.15
  return { logKey: 'restart.useless', effective: false };
}
```

**与 LEVEL 1 的关键区别**：

| | LEVEL 1 | LEVEL 2 |
|---|---|---|
| Impact | 归零 | **不归零** |
| 证据 | 丢失 | 丢失 |
| 额外惩罚 | 阶段倍率 +0.5 | **连接池负载 ×1.15**（惊群） |

**为什么重启在 LEVEL 2 完全无效**：缓存是**分布式**的。重启应用实例不会清空 Redis 里的数据，也不会重建已经过期的缓存。反而，所有实例同时重启会造成启动瞬间的请求惊群，让连接池雪上加霜。

> **这是系列设计的第二次教学**：LEVEL 1 说"重启有代价"，LEVEL 2 说"**有些故障重启根本没用**"。

#### `C_ROLLBACK` · 回滚发布 ⚠️ 假修复

```javascript
effect: (s) => {
  return { logKey: 'rollback.useless', effective: false };
}
```

**它不解决问题**，因为 TTL 配置是三个月前就写死的，与昨晚的发布无关。但它**看起来非常合理**——毕竟 `比对变更` 刚刚告诉你"昨晚有一次发布"。

> **这是本关最阴险的一张卡**：它不是随机的干扰，而是被一条**看起来很有说服力的证据**诱导出来的错误决策。玩家会在结算时看到："你回滚了。但故障和那次发布没有关系。"

#### `C_OPS` · 拉大促运营进群

```javascript
effect: (s) => {
  if (s.opsJoined) return { logKey: 'ops.repeat', effective: false };
  s.opsJoined = true;
  return { logKey: 'ops.joined', effective: true };
}
```

**效果**：如果之后使用 `C_DEGRADE`，运营会主动确认"哪些功能可以关"，从而**减免降级的副作用**：

```javascript
// 在 C_DEGRADE 中检查
if (s.opsJoined) {
  s.mitigationFactor *= 0.6;      // 同样效果
  s.degradeCostReduced = true;    // 但不计入"受影响用户"
}
```

**这是一张"组合卡"**——单独使用没有即时收益，必须配合降级才有价值。它的存在是为了测试：**玩家是否愿意为"未来可能用到的选项"提前花 2 分钟？**

---

## 6. 事件触发器

### 6.1 阶段事件

| Key | 触发 | 作用 |
|---|---|---|
| `event.p2` | t ≥ 5 | 缓存命中率断崖式下跌的播报 |
| `event.p3` | t ≥ 15 | 数据库告警 |
| `event.p4` | t ≥ 30 | 数据库濒危 |

### 6.2 DB Health 危险线（新增）

| Key | 触发 | 文本基调 |
|---|---|---|
| `event.db_warn` | `dbHealth < 60` | 黄灯。陈述事实 |
| `event.db_critical` | `dbHealth < 30` | 红灯。给出明确倒计时 |
| `event.db_dead` | `dbHealth <= 0` | **立即失败**，触发数据事件 |

> `event.db_critical` **必须显示预计剩余时间**（用解析解反算），把抽象的血条变成具体的时间压力。

### 6.3 复发事件

| Key | 触发 |
|---|---|
| `event.preheat_expired` | 预热后 15 分钟仍未根治 |

### 6.4 强制接管

沿用 LEVEL 1 机制，但条件调整：

```javascript
if (state.timeElapsed >= 25
    && !state.rootCauseConfirmed
    && !state.escalationBlocked
    && !state.firedTriggers.has('forced_restart')) { ... }
```

**注意**：LEVEL 2 中强制重启的后果**更严重**（惊群 + 证据丢失 + Impact 不清零），因为重启在这里是纯负面的。

---

## 7. 胜负判定与结算

### 7.1 判定

```javascript
function checkVictoryL2(s) {
  if (s.rootCauseFixed) return s.result = 'win_root';
  if (s.tripped && s.timeElapsed >= s.timeLimit) return s.result = 'win_mitigated';
}

function checkFailureL2(s) {
  if (s.dbHealth <= 0) return s.result = 'lose_data';     // 优先级最高
  if (s.impact >= 200) return s.result = 'lose_impact';
  if (s.timeElapsed >= s.timeLimit) return s.result = 'lose_timeout';
}
```

### 7.2 评级

```javascript
function calcRankL2(s) {
  if (s.result.startsWith('lose')) return 'F';

  if (s.result === 'win_mitigated') {
    return (s.restartCount > 0) ? 'D' : 'C';
  }

  let rank;
  if (s.impact < 40)       rank = 'S';
  else if (s.impact < 90)  rank = 'A';
  else                     rank = 'B';

  if (s.restartCount > 0 && rankBetterThan(rank, 'B')) rank = 'B';
  return demote(rank, s);   // 超频降级，复用 LEVEL 1 逻辑
}
```

### 7.3 评级阈值

| 评级 | 条件 |
|---|---|
| **S** | 根治 + Impact < 40 + 未重启 + 未超频 |
| **A** | 根治 + Impact < 90 + 未重启 + 未超频 |
| **B** | 根治 + Impact ≥ 90；或 根治但重启过 |
| **C** | **熔断止血通关** |
| **D** | 熔断止血通关 + 重启过 |
| **F** | 失败 |

> **C / D 在 LEVEL 2 首次可达。** 这是本关的结构性意义——它让"我放弃了根治，但我保住了系统"成为一个被承认的结果。

### 7.4 结算数据项（新增）

在 LEVEL 1 的结算项基础上追加：

| 项 | 来源 |
|---|---|
| **数据库健康度** | `dbHealth` / 100 |
| **连接池峰值占用** | 记录整局的 `maxPoolUsage` |
| **缓存命中率** | `cacheHitRate` 终值 |
| **因熔断未能下单的用户** | `tripped ? round(impact × 32) : 0`，仅熔断时显示 |
| **扩容的反效果** | `scaleCount > 0` 时显示：「你扩容了 {N} 次，数据库因此提前约 12 分钟进入危险区」 |

---

## 8. 边界情况

| 情况 | 处理 |
|---|---|
| 熔断后使用 `C_DEPLOY` | **允许**。玩家可以在止血后继续根治，此时评级按 `win_root` 计算——但因为熔断的 50 点一次性影响，通常只能拿到 B。**这是合理的：你先放弃了业务，然后又修好了，功过相抵** |
| 熔断后 `impact` 仍 ≥ 200 | 不可能。熔断后 severity = 0，impact 不再增长。但若熔断时 impact 已 ≥ 200，则失败判定优先 |
| 预热后立即发版 | 正常。预热 4 分钟 + 发版 8 分钟，共 12 分钟，远短于 15 分钟的复发窗口 |
| 预热 → 复发 → 再预热 | **不允许**（`maxUses: 1`）。这是刻意的——不给玩家"反复治标"的退路 |
| 扩容后 `scaleCount` 为 2 | `load × 1.3² = ×1.69`，`drain × 1.5`（不累乘）。第二次扩容的收益更差 |
| `C_TTL` 在没有 E3 时点击 | 按钮置灰 |
| DB Health 在回合中途归零 | 由 `advanceTimeAndBothMeters` 的分段积分自然处理，回合结束后统一判定 |

---

## 9. 验收清单

- [ ] 被动不操作：连接池在 t=5 打满，DB Health 在 **t ≈ 27.9** 归零，判定 `lose_data`
- [ ] 扩容（t=0 立即生效）：连接池在 t=0 打满，DB Health 在 **t ≈ 15.3** 归零
- [ ] 路径 A（标准解）结束：Impact ≈ **46.65**，DB Health ≈ **97.4**，评级 **A**
- [ ] 路径 B（视界解）结束：Impact ≈ **28.05**，评级 **S**
- [ ] 路径 C（熔断止血）：Impact ≈ **63.5**，评级 **C**
- [ ] 路径 D（扩容后慢诊断）：DB 在 **t ≈ 18.35** 死亡，Impact ≈ **71.09**，判定 `lose_data`，评级 **F**
- [ ] 预热后 15 分钟未根治 → 命中率回到 0.12，连接池重新打满
- [ ] 预热后 12 分钟内根治 → 不复发
- [ ] 重启不减少 Impact，且连接池负载 ×1.15
- [ ] 熔断后 Impact 停止增长，且一次性 +50
- [ ] 限流 + 降级叠加后 `mitigationFactor = 0.3`
- [ ] 数值积分步长 0.05，DB 死亡时刻误差 < 0.3 分钟

---

## 10. 参考通关路径

### 路径 A · 标准解（预期 A）

| 回合 | 行动 | 时间 | Impact | DB Health |
|---|---|---|---|---|
| 1 | 看监控大盘 | 0 | 0 | 100 |
| 2 | 看日志 | 1 | 3.00 | 100 |
| 3 | 查看缓存命中率 | 3 | 9.00 | 100 |
| 4 | 检查过期时间配置 | 5 | 15.00 | 100 |
| 5 | 限流 | 6 | 18.90 | 97.4 |
| 6 | 同步进展 | 7 | 20.85 | 97.4 |
| 7 | 预热缓存 | 11 | 28.65 | 97.4 |
| 8 | 改代码 + 发版 | 19 | **46.65** | **97.4** |

**评级 A**（根治，Impact < 90，未重启未超频）

> 注意第 4→5 回合：连接池在 t=5 短暂打满，DB Health 掉了约 2.6 点。**这是设计意图**——让玩家在大盘上看到一次"擦肩而过"，从而理解连接池的意义。限流一旦生效，池占用从 50 掉到 29，掉血立即停止。

### 路径 B · 视界解（预期 S）

| 回合 | 行动 | 时间 | Impact |
|---|---|---|---|
| 1 | 看监控大盘 | 0 | 0 |
| 2 | 看日志 | 1 | 3.00 |
| 3 | **开启视界** | 1 | 3.00 |
| 4 | 限流 | 2 | 6.00 |
| 5 | 预热缓存 | 6 | 12.45 |
| 6 | 改代码 + 发版 | 14 | **28.05** |

**评级 S** · 带宽剩余 2

### 路径 C · 熔断止血（预期 C）

| 回合 | 行动 | 时间 | Impact | 备注 |
|---|---|---|---|---|
| 1 | 看监控大盘 | 0 | 0 | |
| 2 | 看日志 | 1 | 3.00 | |
| 3 | 查看缓存命中率 | 3 | 9.00 | |
| 4 | 限流 | 4 | 12.00 | |
| 5 | **熔断** | 5 | **63.50** | +50 一次性 |
| — | 系统存活至时限 | 40 | **63.50** | severity = 0 |

**评级 C**（止血通关）

> 结算会显示：**因你的选择，2032 名用户未能下单。**

### 路径 D · 扩容致死（预期 F）

| 回合 | 行动 | 时间 | Impact | DB Health |
|---|---|---|---|---|
| 1 | **扩容** | 3 | 9.00 | 100 |
| 2 | 二分定位 | 6 | 18.90 | 88.0 |
| 3 | 比对变更 | 8 | 26.70 | 78.0 |
| 4 | 查看缓存命中率 | 10 | 34.50 | 67.0 |
| 5 | 检查过期时间配置 | 12 | 42.30 | 54.0 |
| 6 | 改代码 + 发版 | **18.35** | **71.09** | **0 → 数据事件** |

**评级 F**（`lose_data`）

> 发版还差 **1.65 分钟**完成，数据库先死了。
>
> 注意：扩容本身耗时 3 分钟，所以数据库掉血从 t=3 才开始 —— 死亡时刻因此是 18.35 而非 15.3。**这就是扩容的代价：它把"还有 28 分钟"变成"还有 15 分钟"。**

---

*文档版本：v1.0 · 配套：10-LEVEL2-文案全集、11-LEVEL2-数值表与平衡模型*
