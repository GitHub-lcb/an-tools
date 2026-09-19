# LEVEL 1《幽灵订单》· 实现规格（程序向）

> **文档用途**：程序可直接依据本文档实现灰盒原型，无需额外提问。
> **配套文档**：`07-LEVEL1-文案全集.md`（所有玩家可见文本）、`08-数值表与平衡模型.md`（数值验算）
> **目标平台**：PC 键鼠 · 纯文字界面 · 无美术资产

---

## 0. 版本说明与设计变更

### 0.1 相对 `05-游戏原型设计文档.md` 的变更

| 项 | 原设计 | 本规格 | 原因 |
|---|---|---|---|
| 教学关卡牌数 | 12 张 | **14 张** | 详细设计时发现，若不实现完整的"沟通类"卡牌，就无法验证本作最核心的差异化机制 |
| Impact 阈值 | 100 | 100（不变） | — |
| 初始强度 | 4.0 | **3.0** | 原数值下标准解只能拿到 B，缺少评分梯度。`base` 的可行区间为 `[2.5, 3.4]`，详见 `08` 文档 §7 敏感度分析 |
| 失败主因 | Impact 超阈值 | **时限耗尽** | 验算发现被动玩家在 15 分钟内 Impact 只累积到 64.5，够不到 100。因此**时限才是教学关的主要压力**，Impact 是"你伤害了多少用户"的度量 |
| 视界前置条件 | 无 | **需已有 ≥ 2 条证据** | 否则视界成为无脑最优解，破坏推理乐趣。加上前置条件后，"用视界拿 S"与"自己推理拿 A"形成一个真正的取舍 |

### 0.2 本关的设计意图（实现时不可偏离）

1. **时限是主要压力，Impact 是道德账本。**
2. **必须使用"同步进展"才可能通关。** 正解路径总耗时 15 分钟，恰好等于初始时限——不用沟通卡就一定超时。
3. **"重启服务"是一个必须存在的陷阱。** 它看起来是最优解，实际会清空证据链。
4. **视界是捷径，不是答案。** 它给你结论，但消耗稀缺资源。

---

## 1. 数据结构

### 1.1 关卡状态

```typescript
type Phase = 'P1' | 'P2' | 'P3' | 'P4';
type Result =
  | 'ongoing'
  | 'win_root'        // 根治
  | 'win_mitigated'   // 止血
  | 'lose_impact'     // Impact 超阈值
  | 'lose_timeout'    // 时限耗尽
  | 'lose_data';      // 数据事故

interface IncidentState {
  // ── 时间 ──
  timeElapsed: number;        // 已推进的分钟数，初值 0
  timeLimit: number;          // 时限，初值 15。可被"同步进展"延长

  // ── 故障 ──
  impact: number;             // 0–100，初值 0。>= 100 立即失败
  severityBase: number;       // 常量 3.0
  phaseBonus: number;         // 每次重启 +0.5，初值 0
  mitigationFactor: number;   // 缓解系数，初值 1.0
  restartCount: number;       // 重启次数，初值 0

  // ── 调查 ──
  evidence: Set<EvidenceId>;  // 已获得的证据
  rootCauseConfirmed: boolean;// 是否已确认根因
  rootCauseFixed: boolean;    // 是否已根治
  evidenceLost: boolean;      // 重启后为 true，不可逆
  dataEventTriggered: boolean;// 是否触发数据事故，不可逆

  // ── 资源 ──
  visionBandwidth: number;    // 初值 3
  visionDisabled: boolean;    // 超频后本场禁用
  overclocked: boolean;       // 是否使用过超频
  overclockTurnsLeft: number; // 超频后的加速剩余回合数，初值 0，超频时置 3
  teamStamina: number;        // 初值 5
  teamStaminaMax: number;     // 初值 5

  // ── 沟通 ──
  syncCount: number;          // "同步进展"已成功使用次数，上限 3
  escalateUsedCount: number;  // "向上汇报"已使用次数，上限 1 次生效
  escalationBlocked: boolean; // 是否已压制强制重启事件，初值 false

  // ── 流程 ──
  turnIndex: number;          // 回合序号，从 1 开始
  usedCards: Map<CardId, number>; // 每张卡的使用次数
  firedTriggers: Set<string>; // 已触发过的事件（台词、预警等），防重复

  // ── 结局 ──
  result: Result;
}
```

### 1.2 证据定义

```typescript
type EvidenceId = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7';

interface Evidence {
  id: EvidenceId;
  sourceCard: CardId;     // 由哪张卡产出
  text: string;           // 玩家可见文本，见 07 文档
  tags: string[];         // 用于推理判定
}
```

| ID | 产出卡 | 内容摘要 | 作用 |
|---|---|---|---|
| **E1** | `看日志` | 两次订单创建间隔 40–60ms | 指向"成对出现"，是推理起点 |
| **E2** | `看监控大盘` | 数据库 CPU 23%、连接数 12/50、网络正常 | 排除资源瓶颈 |
| **E3** | `链路追踪` | 上游调用耗时恰好 500ms，随后立即发起第二次调用 | **指向根因模块** |
| **E4** | `比对变更` | 最近 24 小时无任何发布或配置变更 | 排除变更因素 |
| **E5** | `查看上游调用` | 上游策略：500ms 超时，固定间隔重试 3 次 | **确认根因** |
| **E6** | `看日志`（第 2 次） | 订单服务 P99 响应 620ms，超过 500ms 阈值 | 解释"为什么超时" |
| **E7** | `翻历史记录` | 该故障历史出现 37 次，每次间隔规律 | 增强信心（非必需） |

> **前置条件**：所有依赖证据的卡牌，在缺少前置证据时**不可用（按钮置灰）**。见 §5 卡牌规格。

---

## 2. 回合流程

### 2.1 主循环伪代码

```javascript
function playTurn(state, cardId) {
  // ── [1] 合法性校验 ──
  const card = CARDS[cardId];
  const legality = checkLegality(state, card);
  if (!legality.ok) return { ok: false, reason: legality.reason };

  // ── [2] 结算该行动之前的时间 ──
  //     注意：卡牌效果在时间推进之后生效（你花了时间才做成这件事）
  advanceTimeAndImpact(state, card.timeCost);

  // ── [3] 扣除资源 ──
  state.teamStamina -= card.staminaCost;

  // ── [4] 应用卡牌效果 ──
  applyCardEffect(state, card);

  // ── [5] 检查阶段跨越触发的事件 ──
  firePhaseTriggers(state);

  // ── [6] 胜利判定（必须在失败判定之前）──
  //     理由：发版完成时 t 可能恰好等于 timeLimit。
  //     若先判失败，玩家会在通关瞬间被判超时，体验极差。
  checkVictory(state);
  if (state.result !== 'ongoing') return { ok: true, result: state.result };

  // ── [7] 失败判定 ──
  checkFailure(state);
  if (state.result !== 'ongoing') return { ok: true, result: state.result };

  // ── [8] 时限耗尽的兜底 ──
  if (state.timeElapsed >= state.timeLimit) {
    state.result = 'lose_timeout';
    return { ok: true, result: state.result };
  }

  state.turnIndex++;
  return { ok: true, result: 'ongoing' };
}
```

### 2.2 时间与 Impact 推进（分段积分）

**关键实现点**：故障强度随阶段变化，因此推进时间时必须**按阶段边界切分**，不能一乘了事。

```javascript
const PHASES = [
  { id: 'P1', start: 0,  end: 5,        mod: 1.0 },
  { id: 'P2', start: 5,  end: 10,       mod: 1.4 },
  { id: 'P3', start: 10, end: 20,       mod: 1.9 },
  { id: 'P4', start: 20, end: Infinity, mod: 2.5 },
];

function phaseAt(state, t) {
  const p = PHASES.find(p => t >= p.start && t < p.end);
  return { ...p, mod: p.mod + state.phaseBonus };
}

function severityAt(state, t) {
  const p = phaseAt(state, t);
  return state.severityBase * p.mod * state.mitigationFactor;
}

function advanceTimeAndImpact(state, deltaMinutes) {
  let remaining = deltaMinutes;
  let cursor = state.timeElapsed;

  while (remaining > 1e-9) {
    const p = phaseAt(state, cursor);
    const slice = Math.min(remaining, p.end - cursor);
    state.impact += severityAt(state, cursor) * slice;
    cursor += slice;
    remaining -= slice;
  }

  state.timeElapsed = roundTo(cursor, 2);
  state.impact      = roundTo(state.impact, 2);
}
```

### 2.3 无操作回合

玩家可以选择"观察一分钟"（跳过），等价于打出一张 `timeCost = 1, staminaCost = 0` 的空卡。

```javascript
function skipTurn(state) {
  advanceTimeAndImpact(state, 1);
  firePhaseTriggers(state);
  checkFailure(state); checkVictory(state);
  if (state.timeElapsed >= state.timeLimit) state.result = 'lose_timeout';
  state.turnIndex++;
}
```

**设计说明**：跳过**不是**废操作。当 `teamStamina` 见底，或需要等待平静期（LEVEL 3）时，跳过是正确选择。LEVEL 1 中跳过通常意味着玩家在犹豫——这时 Impact 会上涨，形成自然的压力。

---

## 3. 故障演化模型

### 3.1 阶段表

| 阶段 | 时间区间（分） | 基础倍率 | 等效强度（无缓解） | 叙事含义 |
|---|---|---|---|---|
| **P1 轻度** | [0, 5) | 1.0 | 3.00 /分 | 局部影响，客服尚未察觉 |
| **P2 恶化** | [5, 10) | 1.4 | 4.20 /分 | 流量叠加，投诉开始进入 |
| **P3 严重** | [10, 20) | 1.9 | 5.70 /分 | 管理层介入 |
| **P4 失控** | [20, ∞) | 2.5 | 7.50 /分 | 事故升级为 P0 |

**最终强度**：

```
severity(t) = 3.0 × (phaseMod(t) + phaseBonus) × mitigationFactor
```

### 3.2 重启惩罚

```javascript
function applyRestartPenalty(state) {
  state.phaseBonus += 0.5;   // 永久，可累加
  state.restartCount += 1;
}
```

重启后各阶段等效倍率：

| 重启次数 | P1 | P2 | P3 | P4 |
|---|---|---|---|---|
| 0 | 1.0 | 1.4 | 1.9 | 2.5 |
| 1 | 1.5 | 1.9 | 2.4 | 3.0 |
| 2 | 2.0 | 2.4 | 2.9 | 3.5 |

### 3.3 被动失败曲线（玩家完全不操作）

| 时刻 | 累计 Impact | 阶段 |
|---|---|---|
| 5 分 | 15.00 | P1 结束 |
| 10 分 | 36.00 | P2 结束 |
| **15 分** | **64.50** | **时限耗尽 → 失败** |
| 20 分 | 93.00 | 若已延长时间，仍未破线 |
| 21.2 分 | **100.00** | Impact 破线 |

**结论**：教学关的被动失败是**超时**，不是 Impact。Impact 破线只会在玩家主动延长时限后继续拖延时发生（约 21.2 分钟）。

---

## 4. 证据链与根因确认

### 4.1 依赖关系图

```
                    ┌──────────────┐
                    │ 看监控大盘    │ → E2（排除资源瓶颈）
                    │ (0分, 0精力)  │
                    └──────────────┘

                    ┌──────────────┐
                    │ 看日志        │ → E1（40–60ms 间隔）
                    │ (1分, 0精力)  │ → 第 2 次使用产出 E6（P99=620ms）
                    └───────┬──────┘
                            │ 需要 E1
                            ▼
                    ┌──────────────┐
                    │ 链路追踪      │ → E3（上游 500ms 超时）
                    │ (2分, 1精力)  │
                    └───────┬──────┘
                            │ 需要 E3
                            ▼
                    ┌──────────────┐
                    │ 查看上游调用  │ → E5 ★ 确认根因
                    │ (2分, 1精力)  │
                    └──────────────┘

   ┌──────────────┐
   │ 翻历史记录    │ → E7（历史 37 次）   [可选支线]
   │ (3分, 1精力)  │
   └──────────────┘

   ┌──────────────┐
   │ 比对变更      │ → E4（无变更）        [可选支线]
   │ (2分, 1精力)  │
   └──────────────┘
```

### 4.2 根因确认规则

```javascript
function checkRootCause(state) {
  // 主路径：拿到 E5 即确认
  if (state.evidence.has('E5')) {
    state.rootCauseConfirmed = true;
  }
  // 视界路径：直接置位（见 §5.13）
}
```

**注意**：`rootCauseConfirmed` 只影响"改代码 + 发版"这张卡的可用性，**不产生任何分数**。分数只看最终结果。

### 4.3 重启对证据的影响

```javascript
function onRestart(state) {
  state.impact = 0;
  state.evidence.clear();          // 证据全部丢失
  state.rootCauseConfirmed = false;
  state.evidenceLost = true;       // 不可逆
  applyRestartPenalty(state);
  // mitigationFactor 保留（限流等策略仍在生效）
}
```

**实现细节**：重启后 `evidenceLost = true`，此时：

| 卡牌 | 重启后行为 |
|---|---|
| `看日志` | 仍可用，但**产出的是重启后的新日志**，无法产出 E1 / E6 |
| `链路追踪` | 不可用（前置 E1 已丢失） |
| `查看上游调用` | 不可用（前置 E3 已丢失） |
| `二分定位` | 仍可用（不依赖现场证据） |
| **`视界`** | **仍可用**——这是重启玩家唯一的翻盘手段 |

> **这是本关最重要的一条平衡规则**：重启封死了所有常规诊断路径，**但没封死视界**。玩家如果还有带宽，仍能翻盘——只是评分被封顶在 B，且 Impact 已经很高。
>
> 这让重启成为一个"可以挽救但代价惨重"的错误，而不是"game over"。**玩家会记住这个教训，而不是愤怒地退出。**

---

## 5. 卡牌规格

### 5.1 卡牌数据结构

```typescript
interface Card {
  id: CardId;
  name: string;
  category: 'observe' | 'diagnose' | 'mitigate' | 'fix' | 'communicate';
  timeCost: number;
  staminaCost: number;
  requires?: (s: IncidentState) => boolean;  // 前置条件
  maxUses?: number;
  effect: (s: IncidentState) => EffectResult;
}

interface EffectResult {
  logKey: string;          // 文案 key，见 07 文档
  gainedEvidence?: EvidenceId[];
  effective: boolean;      // 是否产生了正面效果（用于结算统计）
}
```

### 5.2 卡牌总表

| ID | 名称 | 类别 | 时间 | 精力 | 前置 | 次数上限 |
|---|---|---|---|---|---|---|
| `C_MONITOR` | 看监控大盘 | observe | 0 | 0 | — | ∞ |
| `C_LOG` | 看日志 | observe | 1 | 0 | — | 2 |
| `C_TRACE` | 链路追踪 | diagnose | 2 | 1 | 有 E1 | ∞ |
| `C_HISTORY` | 翻历史记录 | observe | 3 | 1 | — | 1 |
| `C_BISECT` | 二分定位 | diagnose | 3 | 1 | — | 2 |
| `C_DIFF` | 比对变更 | diagnose | 2 | 1 | — | 1 |
| `C_UPSTREAM` | 查看上游调用 | diagnose | 2 | 1 | 有 E3 | 1 |
| `C_RATELIMIT` | 限流 | mitigate | 1 | 1 | — | 1 |
| `C_SCALE` | 扩容 | mitigate | 3 | 2 | — | 2 |
| `C_RESTART` | 重启服务 | mitigate | 1 | 1 | — | ∞ |
| `C_CACHE` | 加缓存 | fix | 4 | 2 | — | 1 |
| `C_INDEX` | 加索引 | fix | 5 | 2 | — | 1 |
| `C_DEPLOY` | 改代码 + 发版 | fix | 8 | 3 | 已确认根因 | 1 |
| `C_SYNC` | 同步进展 | communicate | 1 | 1 | — | 3 次生效 |
| `C_ESCALATE` | 向上汇报 | communicate | 2 | 1 | — | 1 次生效 |
| `C_VISION` | **开启视界** | — | 0 | 0 | 有 ≥2 条证据 | 受带宽限制 |

> 共 16 张。其中 `C_HISTORY`、`C_DIFF`、`C_CACHE`、`C_INDEX` 为支线干扰卡。

---

### 5.3 `C_MONITOR` · 看监控大盘

| 项 | 值 |
|---|---|
| 时间 / 精力 | 0 / 0 |
| 前置 | 无 |
| 次数 | 无限 |
| 效果 | 获得 E2。显示当前 Impact、时限、各服务健康状态 |

```javascript
effect: (s) => ({
  logKey: 'monitor.dashboard',
  gainedEvidence: ['E2'],
  effective: true,
})
```

**首次使用时额外显示**：`当前 Impact 增速：约 3.5 / 分钟`（由 `severityAt` 实算，不要写死）。这让玩家第一次意识到时间的价格。

---

### 5.4 `C_LOG` · 看日志

| 项 | 值 |
|---|---|
| 时间 / 精力 | 1 / 0 |
| 前置 | 无 |
| 次数 | 2 |
| 效果 | 第 1 次 → E1；第 2 次 → E6；第 3 次起不可用 |
| **重启后** | 仍可用，但**不产出任何证据**，只返回"日志已被轮转，最早的记录是 3 分钟前" |

```javascript
effect: (s) => {
  if (s.evidenceLost) {
    return { logKey: 'log.afterRestart', effective: false };
  }
  const n = s.usedCards.get('C_LOG') ?? 0;
  if (n === 0) return { logKey: 'log.first',  gainedEvidence: ['E1'], effective: true };
  return             { logKey: 'log.second', gainedEvidence: ['E6'], effective: true };
}
```

**这是本关性价比最高的卡**：1 分钟产出一条关键证据。设计意图是让玩家第一次就尝到"看日志有用"的甜头。

---

### 5.5 `C_TRACE` · 链路追踪

| 项 | 值 |
|---|---|
| 时间 / 精力 | 2 / 1 |
| 前置 | **拥有 E1** |
| 次数 | 无限（但重复使用无新信息） |
| 效果 | 获得 E3 |

```javascript
requires: (s) => s.evidence.has('E1'),
effect: (s) => s.evidence.has('E3')
  ? { logKey: 'trace.repeat', effective: false }
  : { logKey: 'trace.first', gainedEvidence: ['E3'], effective: true },
```

**前置条件的必要性**：如果没有 E1，玩家不知道该追踪哪条请求。这也向玩家传达一个真实的工程直觉——**先看日志，再上工具**。

---

### 5.6 `C_HISTORY` · 翻历史记录

| 项 | 值 |
|---|---|
| 时间 / 精力 | 3 / 1 |
| 前置 | 无（但**老赵解锁后才出现**，教学关中默认可用） |
| 次数 | 1 |
| 效果 | 获得 E7 |

```javascript
effect: () => ({ logKey: 'history.first', gainedEvidence: ['E7'], effective: true })
```

**设计意图**：这是一张**诱人的干扰卡**。3 分钟换一条"历史出现过 37 次"的信息——听起来很有价值，但它**对通关毫无帮助**。玩家会为了它花掉 3 分钟，然后在时限压力下后悔。

**这正是本作要教的另一件事：不是所有信息都值得获取。**

---

### 5.7 `C_BISECT` · 二分定位

| 项 | 值 |
|---|---|
| 时间 / 精力 | 3 / 1 |
| 前置 | 无 |
| 次数 | 2 |
| 效果 | 第 1 次：排除「数据库资源瓶颈」与「网络抖动」两条分支；第 2 次：排除「代码逻辑缺陷」与「恶意刷单」 |

```javascript
effect: (s) => {
  const n = s.usedCards.get('C_BISECT') ?? 0;
  return n === 0
    ? { logKey: 'bisect.first',  effective: true }
    : { logKey: 'bisect.second', effective: false };  // 第二次不再产生新结论
}
```

第 1 次使用后返回文本（见 07 文档）：

> 对比 8 个服务实例的指标：CPU、内存、连接池、网络延迟——**全部正常**。
> 问题不在资源层。
> 剩余可能：上游调用异常 / 代码逻辑缺陷 / 恶意请求

**第二次使用无新结论**，只返回"已经排除完毕，剩下的方向需要具体证据"。这是一张"用一次就够"的卡——防止玩家把时间浪费在反复定位上。

---

### 5.8 `C_DIFF` · 比对变更

| 项 | 值 |
|---|---|
| 时间 / 精力 | 2 / 1 |
| 前置 | 无 |
| 次数 | 1 |
| 效果 | 获得 E4 |

```javascript
effect: () => ({ logKey: 'diff.none', gainedEvidence: ['E4'], effective: true })
```

**设计意图**：这是**工程直觉的示范卡**。"出事了先看最近改了什么"是资深工程师的第一反应。本关答案是"什么都没改"，这既排除了一个方向，也暗示了真正的原因（**没改代码也会出事，说明是流量或依赖变了**）。

---

### 5.9 `C_UPSTREAM` · 查看上游调用

| 项 | 值 |
|---|---|
| 时间 / 精力 | 2 / 1 |
| 前置 | **拥有 E3** |
| 次数 | 1 |
| 效果 | 获得 E5，并置 `rootCauseConfirmed = true` |

```javascript
requires: (s) => s.evidence.has('E3'),
effect: (s) => {
  s.rootCauseConfirmed = true;
  return { logKey: 'upstream.retry', gainedEvidence: ['E5'], effective: true };
}
```

**这是正交路径的终点卡**，也是全关最重要的一张。使用后应播放明显的正反馈（音效 + 高亮）。

---

### 5.10 `C_RATELIMIT` · 限流

| 项 | 值 |
|---|---|
| 时间 / 精力 | 1 / 1 |
| 前置 | 无 |
| 次数 | 1（重复使用无叠加） |
| 效果 | `mitigationFactor = 0.5` |

```javascript
effect: (s) => {
  if (s.mitigationFactor <= 0.5) return { logKey: 'ratelimit.repeat', effective: false };
  s.mitigationFactor = 0.5;
  return { logKey: 'ratelimit.on', effective: true };
}
```

**副作用（必须实现）**：使用后，界面上永久显示一行 `⚠ 部分用户请求被拒绝（HTTP 429）`。结算时计入"受影响用户"。

---

### 5.11 `C_SCALE` · 扩容 ⚠️ 陷阱卡

| 项 | 值 |
|---|---|
| 时间 / 精力 | 3 / 2 |
| 前置 | 无 |
| 次数 | 2 |
| 效果 | **本关完全无效**，纯粹浪费 3 分钟 |

```javascript
effect: () => ({ logKey: 'scale.useless', effective: false })
```

返回文本：

> 实例数：8 → 20
> 错误率：**无变化**
> Impact 增速：**无变化**
>
> 问题不在容量。

**设计意图**：这是玩家的**第一个错误直觉**。它不造成灾难，只浪费时间——**而时间是本关最贵的资源**。玩家会在结算时看到"你花了 3 分钟在无效操作上"。

---

### 5.12 `C_RESTART` · 重启服务 ⚠️⚠️ 核心陷阱

| 项 | 值 |
|---|---|
| 时间 / 精力 | 1 / 1 |
| 前置 | 无 |
| 次数 | 无限 |
| 效果 | 见下方伪代码 |

```javascript
effect: (s) => {
  const wasLost = s.evidenceLost;
  onRestart(s);                 // 见 §4.3
  return {
    logKey: s.restartCount === 1 ? 'restart.first' : 'restart.repeat',
    effective: false,           // 永远不计为有效操作
  };
}
```

**为什么要把它做得如此诱人**：

| 呈现 | 实现 |
|---|---|
| 成本栏显示 `1 分钟 · 1 精力`，是全表最低之一 | `timeCost: 1, staminaCost: 1` |
| 使用后 Impact **立刻归零** | `state.impact = 0` |
| 界面播放一次短促的"恢复"动画与音效 | 见 07 文档 `restart.first` |
| 顶部横幅从红色变回绿色 | UI 状态跟随 `impact` |

**玩家会在第 2 回合用掉它**——因为看起来太好了。

**后果必须清晰地呈现给玩家**：

1. 第 5.13 秒后，故障强度**明显高于重启前**（`phaseBonus` +0.5）
2. 界面右上角永久显示 `⚠ 现场证据已丢失`
3. 所有依赖证据的卡牌**变灰**
4. 结算时评级**封顶 B**

**设计红线**：**不要用弹窗警告玩家。** 这个陷阱的全部价值在于玩家自己踩。任何"你确定吗？"的确认框都会毁掉这个设计。

---

### 5.13 `C_VISION` · 开启视界

| 项 | 值 |
|---|---|
| 时间 / 精力 | **0** / 0 |
| 前置 | **已有 ≥ 2 条证据** |
| 代价 | 1 点视界带宽 |
| 效果 | 直接置 `rootCauseConfirmed = true` |

```javascript
requires: (s) => s.evidence.size >= 2 && !s.visionDisabled,
effect: (s) => {
  if (s.visionBandwidth <= 0) return overclock(s);
  s.visionBandwidth -= 1;
  s.rootCauseConfirmed = true;
  return { logKey: 'vision.reveal', effective: true };
}
```

**前置条件的设计理由**：程叙的视界不稳定，他需要"有东西可看"才能聚焦。机制上表现为——**你必须先动手调查，才能用视界**。

这既符合设定，也避免了"开局开视界 → 直接发版"的无脑最优解。

#### 超频分支

```javascript
function overclock(s) {
  s.overclocked = true;
  s.visionDisabled = true;        // 本场剩余时间禁用视界
  s.rootCauseConfirmed = true;    // 揭示精确位置
  s.overclockTurnsLeft = 3;       // 接下来 3 回合所有行动时间成本 × 0.5
  return { logKey: 'vision.overclock', effective: true };
}
```

| 超频效果 | 超频代价 |
|---|---|
| 立即确认根因 | 本场禁用视界 |
| 接下来 3 回合所有卡牌 `timeCost × 0.5`（向下取整，最小 1） | **结算评级降一级** |

**时间成本减半的实现**：

```javascript
function effectiveTimeCost(state, card) {
  let t = card.timeCost;
  if (state.overclockTurnsLeft > 0 && t > 0) {
    t = Math.max(1, Math.floor(t * 0.5));
  }
  return t;
}
// 每回合结束时：if (state.overclockTurnsLeft > 0) state.overclockTurnsLeft--;
```

---

### 5.14 `C_DEPLOY` · 改代码 + 发版 ★ 正解

| 项 | 值 |
|---|---|
| 时间 / 精力 | 8 / 3 |
| 前置 | **`rootCauseConfirmed === true`** |
| 次数 | 1 |
| 效果 | `rootCauseFixed = true` → 关卡胜利 |

```javascript
requires: (s) => s.rootCauseConfirmed,
effect: (s) => {
  s.rootCauseFixed = true;
  return { logKey: 'deploy.success', effective: true };
}
```

**8 分钟是全关最长的一次行动。** 这 8 分钟里 Impact 全额累积——**玩家必须提前用限流把强度压下来**。

这是本关的核心教学：**缓解不是为了解决问题，是为了买得起解决问题的时间。**

**依赖前置信心的门槛**：前置条件为 `rootCauseConfirmed` 而非"拥有 E5"。这意味着**重启 + 视界**的路径也能通关——这是刻意的仁慈（见 §4.3）。

---

### 5.15 `C_CACHE` / `C_INDEX` · 干扰修复卡

| 卡 | 时间 / 精力 | 效果 |
|---|---|---|
| `C_CACHE` 加缓存 | 4 / 2 | 无效。返回"缓存命中率已提升，但重复订单仍在产生" |
| `C_INDEX` 加索引 | 5 / 2 | 无效。返回"慢查询数量下降，但重复订单仍在产生" |

```javascript
effect: () => ({ logKey: 'fix.wrongTarget', effective: false })
```

**设计意图**：这两张卡惩罚"不看证据就动手"的玩家。它们各浪费 4–5 分钟——在 15 分钟的关卡里是致命的。

**注意**：它们**不会**触发数据事故。教学关应该教"浪费时间很贵"，而不是"你搞坏了系统"。数据事故留给 LEVEL 2。

---

### 5.16 `C_SYNC` · 同步进展 ★ 本作特色卡

| 项 | 值 |
|---|---|
| 时间 / 精力 | 1 / 1 |
| 前置 | 无 |
| 次数 | **前 3 次生效**，第 4 次起返回失效文案 |
| 效果 | `timeLimit += 10` |

```javascript
effect: (s) => {
  if (s.syncCount >= 3) return { logKey: 'sync.exhausted', effective: false };
  s.syncCount += 1;
  s.timeLimit += 10;
  return { logKey: `sync.${s.syncCount}`, effective: true };
}
```

**为什么最多 3 次**：在真实职场里，"同步进展"是有额度的。你不能每 5 分钟就去找老板要时间——第三次之后，对方会开始怀疑你的能力。

返回文本随次数变化（见 07 文档）：

| 次数 | 结果 |
|---|---|
| 1 | 韩立冬：「行，我等你到十点二十。」 |
| 2 | 韩立冬：「又一次。我在听。」 |
| 3 | 韩立冬：「这是最后一次延。十点四十，我要结果。」 |
| 4+ | 韩立冬没有回复。**会议邀请已经建好了。**（失效，且不消耗时间？→ **仍消耗 1 分钟**，让它有真实成本） |

**这一张卡是本作差异化的核心。** 它告诉玩家一件所有其他游戏都不会说的事：**沟通是正经工作，而且它有时间成本。**

---

### 5.17 `C_ESCALATE` · 向上汇报

| 项 | 值 |
|---|---|
| 时间 / 精力 | 2 / 1 |
| 前置 | 无 |
| 次数 | 1 次生效 |
| 效果 | 压制管理层干预，**清除一次即将触发的强制接管事件** |

```javascript
effect: (s) => {
  if (s.escalateUsedCount >= 1) return { logKey: 'escalate.exhausted', effective: false };
  s.escalateUsedCount += 1;
  s.escalationBlocked = true;
  return { logKey: 'escalate.success', effective: true };
}
```

**与强制接管事件的联动**（见 §6.2）：

- 当 `timeElapsed >= 12` 且 `escalationBlocked === false` 时，触发"韩立冬要求立刻重启"事件
- 该事件会**强制打出一次 `C_RESTART`**（玩家失去控制权）
- 如果玩家提前用了 `C_ESCALATE`，事件被压制，不会触发

**这是一个"预判型"卡牌。** 玩家必须在事件发生前用它。用早了浪费 2 分钟，用晚了就没用了。

> **实现提示**：这是原型中唯一一张"赌未来"的卡。它的存在是为了测试——玩家是否愿意为**尚未发生的风险**付出确定成本？如果测试数据显示没人用它，考虑在界面上给出更明确的暗示。

---

## 6. 事件触发器

### 6.1 阶段跨越触发

```javascript
const PHASE_TRIGGERS = [
  { key: 'enter_p2', when: t => t >= 5,  logKey: 'event.p2', sfx: 'alarm_soft' },
  { key: 'enter_p3', when: t => t >= 10, logKey: 'event.p3', sfx: 'alarm_hard' },
  { key: 'enter_p4', when: t => t >= 20, logKey: 'event.p4', sfx: 'alarm_critical' },
];

function firePhaseTriggers(state) {
  for (const tr of PHASE_TRIGGERS) {
    if (tr.when(state.timeElapsed) && !state.firedTriggers.has(tr.key)) {
      state.firedTriggers.add(tr.key);
      pushLog(state, tr.logKey);
      playSfx(tr.sfx);
    }
  }
}
```

### 6.2 强制接管事件

```javascript
// 在每个回合结束时检查
if (state.timeElapsed >= 12
    && !state.escalationBlocked
    && !state.firedTriggers.has('forced_restart')) {
  state.firedTriggers.add('forced_restart');
  pushLog(state, 'event.forced_restart');
  // 强制执行一次重启，不消耗玩家回合
  onRestart(state);
  checkVictory(state);
}
```

**设计意图**：这是给"不用沟通卡"的玩家的第二重惩罚。它会**毁掉证据链**。

但注意：通关正解路径在 t=15 就结束了，而事件在 t=12 触发。所以**不用 `C_ESCALATE` 的玩家会吃到这一击**。

等等——这意味着正解路径必须包含 `C_ESCALATE`？让我验算。

正解路径：看监控(0) → 看日志(1) → 链路追踪(2) → 同步(1) → 上游(2) → 限流(1) → 发版(8) = 15 分钟

t=12 时事件触发 → 强制重启 → 证据清空 → **发版卡失效（rootCauseConfirmed 被重置）** → 玩家卡死

这太严苛了。让我调整。

**修正方案**：强制接管事件只在 **`rootCauseConfirmed === false`** 时触发。也就是说，**已经找到根因的玩家不会被干扰**——这符合逻辑（老板不会打断一个正在解决问题的人）。

```javascript
if (state.timeElapsed >= 12
    && !state.rootCauseConfirmed        // ← 关键条件
    && !state.escalationBlocked
    && !state.firedTriggers.has('forced_restart')) { ... }
```

这样就合理了：
- 已经确认根因 → 老板不会来捣乱
- 还在瞎找 → 老板会强行要求"先重启恢复再说"

**这非常真实。** 而且它给 `C_ESCALATE` 找到了正确的定位：**它是给"还在调查中"的玩家用的保险**。

### 6.3 老赵台词触发

老赵的台词是氛围与教学，通过触发器弹出。完整文本见 07 文档。

| key | 触发条件 | 作用 |
|---|---|---|
| `zhao_open` | 关卡开始 | 交代背景 |
| `zhao_after_restart` | 首次重启后 | 「你把它叫醒了。但它还会睡着。」 |
| `zhao_after_scale` | 使用扩容后 | 吐槽无效操作 |
| `zhao_after_history` | 使用翻历史记录后 | 「这毛病以前犯过。」 |
| `zhao_low_time` | 剩余时间 ≤ 3 分钟 | 催促 |
| `zhao_on_win_root` | 根治通关 | 结算语 |
| `zhao_on_win_mitigated` | 止血通关 | 结算语 |
| `zhao_on_lose` | 失败 | 结算语 |

---

## 7. 胜负判定与结算

### 7.1 判定顺序

```javascript
function checkFailure(s) {
  if (s.dataEventTriggered)      return s.result = 'lose_data';
  if (s.impact >= 100)           return s.result = 'lose_impact';
  if (s.timeElapsed >= s.timeLimit) return s.result = 'lose_timeout';
}

function checkVictory(s) {
  if (s.rootCauseFixed) return s.result = 'win_root';

  // 止血：根因未消除，但强度已降到 0 并维持到时限
  if (s.mitigationFactor <= 0 && s.timeElapsed >= s.timeLimit) {
    return s.result = 'win_mitigated';
  }
}
```

> **注**：LEVEL 1 中 `mitigationFactor` 最低只能到 0.5（只有限流），因此**教学关无法达成"止血通关"**。`win_mitigated` 分支保留给 LEVEL 2（可用熔断把强度降到 0.3，配合降级可叠加到 0）。本关实现时保留该分支即可，不会触发。

### 7.2 评级计算

```javascript
function calcRank(s) {
  if (s.result === 'lose_impact' || s.result === 'lose_timeout' || s.result === 'lose_data') {
    return 'F';
  }

  // 止血通关
  if (s.result === 'win_mitigated') return demote('C', s);

  // 根治通关
  let rank;
  if (s.impact < 25)      rank = 'S';
  else if (s.impact < 50) rank = 'A';
  else                    rank = 'B';

  // 重启封顶 B
  if (s.restartCount > 0 && rankBetterThan(rank, 'B')) rank = 'B';

  // 超频降一级
  return demote(rank, s);
}

function demote(rank, s) {
  if (!s.overclocked) return rank;
  const order = ['S', 'A', 'B', 'C', 'D'];
  const i = order.indexOf(rank);
  return order[Math.min(i + 1, order.length - 1)];
}
```

### 7.3 评级阈值表

| 评级 | 条件 |
|---|---|
| **S** | 根治 + Impact < 25 + 未重启 + 未超频 |
| **A** | 根治 + Impact < 50 + 未重启 |
| **B** | 根治，Impact ≥ 50；**或** 根治但重启过；**或** S/A 被超频降级 |
| **C** | 止血通关（LEVEL 1 不可达） |
| **D** | 止血通关且重启过（LEVEL 1 不可达） |
| **F** | 失败 |

### 7.4 结算数据项

结算界面必须展示（完整文案见 07 文档）：

| 项 | 来源 |
|---|---|
| 评级 | `calcRank()` |
| 总耗时 | `timeElapsed` / `timeLimit` |
| 最终 Impact | `impact` |
| 受影响用户数 | `Math.round(impact * 32)`（Impact 1 点 ≈ 32 个用户） |
| 重启次数 | `restartCount` |
| 视界使用 | `3 - visionBandwidth`（含超频标记） |
| 有效操作 / 总操作 | 统计 `effective === true` 的回合数 |
| **浪费的时间** | 统计 `effective === false` 的卡牌的时间成本总和 |
| **学到的技术点** | 按评级与路径动态生成，见 07 文档 |
| **评级判定块** `rankNote` | **仅当评级被封顶或降级时显示。** 必须展示未封顶前的原始评级。规则见 07 文档 §5.1.1 |

> **`rankNote` 的必要性**：重启路径的影响值（31.35）**低于**标准解（43.95），但评级更差（B vs A）。不解释的话，玩家会认为评分系统有 bug。这行说明把"惩罚"变成了"教学"。

> **"浪费的时间"是本关最有力的复盘指标。** 它把"你瞎试了几次"变成一个具体数字，直接推动玩家重玩。

---

## 8. 边界情况

| 情况 | 处理 |
|---|---|
| 精力不足时点击卡牌 | 按钮置灰，tooltip 显示「团队精力不足」 |
| 时限剩余 2 分钟，玩家打出 8 分钟的卡 | **允许**。时间推进后立即判定超时。不要阻止玩家——让后果发生 |
| Impact 在回合中途破 100 | 用分段积分自然处理，`checkFailure` 在推进后统一判定。**不需要中途打断** |
| 视界带宽为 0 时点击视界 | 弹出超频确认。**这是全游戏唯一允许确认框的地方**——因为它不可逆且代价明确 |
| 重复使用 `C_LOG` 第三次 | 按钮置灰（`maxUses: 2`） |
| 重启后使用 `C_BISECT` | 正常生效（不依赖现场证据） |
| `C_ESCALATE` 在 `rootCauseConfirmed` 之后使用 | 仍可打出，但返回文案指出「已经在推进了，不需要再汇报」，**且不消耗生效次数**（宽松处理，避免惩罚谨慎的玩家） |

---

## 9. 实现验收清单

程序实现完成后，逐条验证：

- [ ] 不做任何操作，15 分钟时 Impact ≈ 64.50，判定为 `lose_timeout`
- [ ] 正解路径（§10）打出后，Impact ≈ 43.95，评级 **A**
- [ ] 视界路径（§10）打出后，Impact ≈ 21.00，评级 **S**
- [ ] 第 2 回合使用重启，Impact 归零，`evidenceLost = true`，所有诊断卡变灰
- [ ] 重启后使用视界仍可确认根因并通关，评级封顶 **B**
- [ ] 使用超频后，接下来 3 回合卡牌时间成本减半，最终评级降一级
- [ ] 不使用 `C_SYNC` 时，正解路径必然超时（总耗时 15 ≥ 时限 15 的边界行为需明确：t=15 时判定 `lose_timeout`，需确认发版卡是否能在 t=15 完成）
- [ ] `C_SCALE` 使用两次后不再可用
- [ ] 老赵台词每个 key 只触发一次
- [ ] 结算界面的"浪费的时间"数值与实际无效操作时长一致

> **关于第 7 条**：正解路径总耗时正好 15 分钟，与初始时限**完全相等**。这是一个刻意的边界设计——玩家必须使用 `C_SYNC`。实现时需明确：**发版卡完成后先判定胜利，再判定超时**。否则玩家会在通关的瞬间被判失败，体验极差。

---

## 10. 参考通关路径（用于自动化测试）

### 路径 A · 标准解（预期 A 级）

| 回合 | 行动 | 时间 | Impact |
|---|---|---|---|
| 1 | 看监控大盘 | 0 | 0 |
| 2 | 看日志 | 1 | 3.00 |
| 3 | 链路追踪 | 3 | 9.00 |
| 4 | 同步进展 | 4 | 12.00 |
| 5 | 查看上游调用 | 6 | 19.20 |
| 6 | 限流 | 7 | 23.40 |
| 7 | 改代码 + 发版 | 15 | **43.95** |

**评级 A**（根治，Impact < 50，未重启未超频）

### 路径 B · 视界解（预期 S 级）

| 回合 | 行动 | 时间 | Impact |
|---|---|---|---|
| 1 | 看监控大盘 | 0 | 0 |
| 2 | 看日志 | 1 | 3.00 |
| 3 | **开启视界** | 1 | 3.00 |
| 4 | 限流 | 2 | 6.00 |
| 5 | 改代码 + 发版 | 10 | **21.00** |

**评级 S**（根治，Impact < 25，未重启未超频）

> 带宽剩余 2 点。这是设计意图——**视界买到了分数，但花掉了稀缺资源。**

### 路径 C · 重启后翻盘（预期 B 级）

| 回合 | 行动 | 时间 | Impact |
|---|---|---|---|
| 1 | 看监控大盘 | 0 | 0 |
| 2 | **重启服务** | 1 | 0（`phaseBonus = 0.5`） |
| 3 | 看日志 | 2 | 4.50 |
| 4 | 限流 | 3 | 9.00 |
| 5 | **开启视界** | 3 | 9.00 |
| 6 | 改代码 + 发版 | 11 | **31.35** |

**评级 B**（Impact 本可评 A，因重启封顶）

### 路径 D · 失败（预期 F 级）

| 回合 | 行动 | 时间 | Impact |
|---|---|---|---|
| 1 | 扩容 | 3 | 9.00 |
| 2 | 翻历史记录 | 6 | 19.20 |
| 3 | 加索引 | 11 | 41.70 |
| 4 | 加缓存 | 15 | **64.50** |
| — | 超时 | 15 | **F** |

---

*文档版本：v1.0 · 配套：07-LEVEL1-文案全集、08-数值表与平衡模型*
