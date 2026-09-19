# ============================================================
#  LEVEL 2《决堤》· 数值参考实现与验算脚本
#  用途：复核 09/11 文档中的全部路径数值
#  用法：powershell -ExecutionPolicy Bypass -File verify-balance-l2.ps1
#  注意：本文件必须保存为 UTF-8 with BOM。
# ============================================================

$ErrorActionPreference = 'Stop'

# ── 常量 ────────────────────────────────────────────────
$BASE         = 3.0
$IMPACT_MAX   = 200
$DB_MAX       = 100
$POOL_MAX     = 50
$HIT_INIT     = 0.12
$HIT_PRE      = 0.85
$PREHEAT_LIFE = 15
$SCALE_LOAD   = 1.3
$SCALE_DRAIN  = 1.5
$TRIP_LUMP    = 50
$USER_MULT    = 32
$STEP         = 0.05      # 积分步长（分钟），不可放大

$P_START = @(0,  5, 15,  30)
$P_END   = @(5, 15, 30, 9999)
$P_MOD   = @(1.0, 1.3, 1.7, 2.2)
$P_LOAD  = @(0.50, 0.65, 0.80, 1.00)

function Get-PhaseIndex([double]$t) {
    for ($i = 0; $i -lt $P_START.Count; $i++) {
        if ($t -ge $P_START[$i] -and $t -lt $P_END[$i]) { return $i }
    }
    return $P_START.Count - 1
}

function Get-Pool($s, [double]$phaseLoad) {
    if ($s.tripped) { return 0 }
    $load = $phaseLoad * $s.mit
    $load = $load * [Math]::Pow($SCALE_LOAD, $s.scale)
    if ($s.restart -gt 0) { $load = $load * [Math]::Pow(1.15, $s.restart) }
    $raw = (1 - $s.hit) * 100 * $load
    return [Math]::Min($POOL_MAX, [Math]::Round($raw))
}

function New-State {
    return @{
        t = 0.0; impact = 0.0; db = [double]$DB_MAX
        mit = 1.0; scale = 0; restart = 0
        hit = $HIT_INIT; tripped = $false
        preheatAt = $null; preheatDead = $false
        dead = $false; deadAt = $null; maxPool = 0
    }
}

function Advance-L2($s, [double]$delta) {
    $remaining = $delta
    $guard = 0
    while ($remaining -gt 1e-9 -and -not $s.dead) {
        if (++$guard -gt 20000) { throw "Advance 死循环" }
        $i = Get-PhaseIndex $s.t
        $slice = [Math]::Min([Math]::Min($remaining, [double]$P_END[$i] - $s.t), $STEP)

        $s.impact += $BASE * $P_MOD[$i] * $s.mit * $slice

        $pool = Get-Pool $s $P_LOAD[$i]
        if ($pool -gt $s.maxPool) { $s.maxPool = $pool }
        if ($pool -ge $POOL_MAX) {
            $drain = 2.5 + ($DB_MAX - $s.db) * 0.045
            if ($s.scale -gt 0) { $drain = $drain * $SCALE_DRAIN }
            $s.db -= $drain * $slice
        }

        $s.t = [Math]::Round($s.t + $slice, 6)
        $remaining = [Math]::Round($remaining - $slice, 6)

        if ($s.db -le 0) { $s.db = 0; $s.dead = $true; $s.deadAt = $s.t }
    }
    $s.impact = [Math]::Round($s.impact, 4)
    $s.db     = [Math]::Round([Math]::Max(0, $s.db), 2)
}

function Test-Preheat($s) {
    if ($null -eq $s.preheatAt -or $s.preheatDead) { return }
    if ($s.t - $s.preheatAt -ge $PREHEAT_LIFE) {
        $s.hit = $HIT_INIT
        $s.preheatDead = $true
    }
}

function Run-L2([string]$title, [array]$steps) {
    $s = New-State
    $rows = @()
    $i = 1
    foreach ($st in $steps) {
        if ($s.dead) { break }
        Advance-L2 $s ([double]$st.t)
        if ($st.mit)      { $s.mit = $st.mit }
        if ($st.mitMul)   { $s.mit = [Math]::Round($s.mit * $st.mitMul, 4) }
        if ($st.scale)    { $s.scale += $st.scale }
        if ($st.restart)  { $s.restart += 1 }
        if ($st.preheat)  { $s.hit = $HIT_PRE; $s.preheatAt = $s.t; $s.preheatDead = $false }
        if ($st.trip)     { $s.tripped = $true; $s.mit = 0; $s.impact = [Math]::Round($s.impact + $TRIP_LUMP, 2) }
        Test-Preheat $s
        $rows += [PSCustomObject]@{
            回合 = $i; 行动 = $st.n; 时刻 = $s.t
            Impact = $s.impact; DB = $s.db
            池 = (Get-Pool $s $P_LOAD[(Get-PhaseIndex $s.t)])
        }
        $i++
    }
    Write-Host ""
    Write-Host "── $title " -NoNewline
    Write-Host ("-" * [Math]::Max(1, 44 - $title.Length))
    $rows | Format-Table -AutoSize | Out-String | Write-Host
    if ($s.dead) {
        Write-Host ("  >> 数据库在 t = {0} 分钟被打挂（数据事件）" -f $s.deadAt) -ForegroundColor Red
    } else {
        Write-Host ("  时间 {0} 分   Impact {1}   DB {2}   池峰值 {3}/50" -f $s.t, $s.impact, $s.db, $s.maxPool)
    }
    return $s
}

# ── 路径 A · 标准解 ─────────────────────────────────────
$rA = Run-L2 '路径 A · 标准解（预期 A / Impact 46.65 / DB 97.4）' @(
    @{ n = '看监控大盘';        t = 0 }
    @{ n = '看日志';            t = 1 }
    @{ n = '查看缓存命中率';    t = 2 }
    @{ n = '检查过期时间配置';  t = 2 }
    @{ n = '限流';              t = 1; mit = 0.5 }
    @{ n = '同步进展';          t = 1 }
    @{ n = '预热缓存';          t = 4; preheat = $true }
    @{ n = '改代码 + 发版';     t = 8 }
)

# ── 路径 B · 视界解 ─────────────────────────────────────
$rB = Run-L2 '路径 B · 视界解（预期 S / Impact 28.05）' @(
    @{ n = '看监控大盘';        t = 0 }
    @{ n = '看日志';            t = 1 }
    @{ n = '开启视界';          t = 0 }
    @{ n = '限流';              t = 1; mit = 0.5 }
    @{ n = '预热缓存';          t = 4; preheat = $true }
    @{ n = '改代码 + 发版';     t = 8 }
)

# ── 路径 C · 熔断止血 ───────────────────────────────────
$rC = Run-L2 '路径 C · 熔断止血（预期 C / Impact 63.50）' @(
    @{ n = '看监控大盘';        t = 0 }
    @{ n = '看日志';            t = 1 }
    @{ n = '查看缓存命中率';    t = 2 }
    @{ n = '限流';              t = 1; mit = 0.5 }
    @{ n = '熔断';              t = 1; trip = $true }
    @{ n = '（等待至时限）';    t = 35 }
)

# ── 路径 D · 扩容致死 ───────────────────────────────────
$rD = Run-L2 '路径 D · 扩容致死（预期 F / DB 死于 t≈18.35）' @(
    @{ n = '扩容';              t = 3; scale = 1 }
    @{ n = '二分定位';          t = 3 }
    @{ n = '比对变更';          t = 2 }
    @{ n = '查看缓存命中率';    t = 2 }
    @{ n = '检查过期时间配置';  t = 2 }
    @{ n = '改代码 + 发版';     t = 8 }
)

# ── 被动 & 扩容后的 DB 死亡时刻 ─────────────────────────
$p1 = New-State; Advance-L2 $p1 45
$p2 = New-State; $p2.scale = 1; Advance-L2 $p2 45
Write-Host ""
Write-Host "── DB 死亡时刻对照（预期 被动 27.9 / 扩容 15.3）"
Write-Host ("   被动无操作      → DB 死于 t = {0}" -f $p1.deadAt)
Write-Host ("   使用过一次扩容  → DB 死于 t = {0}" -f $p2.deadAt)

# ── 被动失败曲线中间点 ──────────────────────────────────
$pc = New-State
$curve = @()
foreach ($m in @(5, 15, 27.9)) {
    if (-not $pc.dead) { Advance-L2 $pc ($m - $pc.t) }
    $curve += [PSCustomObject]@{ 时刻 = $m; Impact = $pc.impact; DB = $pc.db }
}
Write-Host ""
Write-Host "── 被动失败曲线（预期 t=15 时 DB 68.4；死亡时 Impact 约 120）"
$curve | Format-Table -AutoSize | Out-String | Write-Host
$passiveImpactAtDeath = $pc.impact
$passiveDbAt15 = ($curve | Where-Object { $_.时刻 -eq 15 }).DB

# ── 预热复发验证 ────────────────────────────────────────
$rPre = New-State
Advance-L2 $rPre 10
$rPre.hit = $HIT_PRE; $rPre.preheatAt = 10
$poolAfterPreheat = Get-Pool $rPre $P_LOAD[(Get-PhaseIndex 10)]
$hitAfterPreheat  = $rPre.hit
Advance-L2 $rPre 14        # 到 t=24，未到 15 分钟窗口
Test-Preheat $rPre
$poolBeforeExpiry = Get-Pool $rPre $P_LOAD[(Get-PhaseIndex 24)]
$hitBeforeExpiry  = $rPre.hit
$expiredBefore    = $rPre.preheatDead
Advance-L2 $rPre 1.5       # 到 t=25.5，超过窗口
Test-Preheat $rPre
$poolAfterExpiry = Get-Pool $rPre $P_LOAD[(Get-PhaseIndex 25.5)]
$hitAfterExpiry  = $rPre.hit
$expiredAfter    = $rPre.preheatDead
Write-Host ""
Write-Host "── 预热复发验证"
Write-Host ("   预热后 t=10         → 池 {0}/50   hit={1}" -f $poolAfterPreheat, $hitAfterPreheat)
Write-Host ("   t=24（未复发）      → 池 {0}/50   hit={1}  已复发={2}" -f $poolBeforeExpiry, $hitBeforeExpiry, $expiredBefore)
Write-Host ("   t=25.5（已复发）    → 池 {0}/50   hit={1}  已复发={2}" -f $poolAfterExpiry, $hitAfterExpiry, $expiredAfter)

# ── 断言 ────────────────────────────────────────────────
Write-Host ""
Write-Host "── 一致性检查"
$fail = 0
function Assert-Near($label, $actual, $expect, $tol = 0.6) {
    $ok = [Math]::Abs([double]$actual - [double]$expect) -le $tol
    if (-not $ok) { $script:fail++ }
    $mark = if ($ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("   [{0}] {1,-30} 实际 {2,-9} 预期 {3}" -f $mark, $label, $actual, $expect)
}
Assert-Near 'A 最终 Impact'      $rA.impact 46.65
Assert-Near 'A 最终 DB'          $rA.db     97.4  1.0
Assert-Near 'B 最终 Impact'      $rB.impact 28.05
Assert-Near 'C 最终 Impact'      $rC.impact 63.50
Assert-Near 'D 数据库死亡时刻'    $rD.deadAt 18.35 0.4
Assert-Near 'D 死亡时 Impact'     $rD.impact 71.09 0.5
Assert-Near '被动数据库死亡时刻'  $p1.deadAt 27.9  0.4
Assert-Near '扩容数据库死亡时刻'  $p2.deadAt 15.3  0.4
Assert-Near 'C 受影响用户'        ([Math]::Round($rC.impact * $USER_MULT)) 2032 20
Assert-Near 'A 未死'              ($(if ($rA.dead) { 1 } else { 0 })) 0 0
Assert-Near 'B 未死'              ($(if ($rB.dead) { 1 } else { 0 })) 0 0
Assert-Near '预热后未复发时命中率' $hitBeforeExpiry 0.85 0.001
Assert-Near '复发后命中率'        $hitAfterExpiry  0.12 0.001
Assert-Near '被动 t=15 时 DB'      $passiveDbAt15 68.4 1.0
Assert-Near '被动死亡时 Impact'    $passiveImpactAtDeath 120 3.0

Write-Host ""
if ($fail -eq 0) { Write-Host "全部通过。" -ForegroundColor Green }
else { Write-Host "$fail 项不一致——请检查 09/10/11 文档。" -ForegroundColor Red; exit 1 }
