# ============================================================
#  LEVEL 1《幽灵订单》· 数值参考实现与验算脚本
#  用途：复核 08-数值表与平衡模型.md 中的全部路径数值
#  用法：powershell -ExecutionPolicy Bypass -File verify-balance.ps1
#  注意：本文件必须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1
#        会按 ANSI 解码，导致中文乱码并使脚本解析失败。
#  调参后必须重跑本脚本，确认 §9 一致性检查清单全部通过
# ============================================================

$ErrorActionPreference = 'Stop'

# ── 常量（唯一来源，改这里）──────────────────────────────
$BASE          = 3.0
$IMPACT_MAX    = 100
$INIT_LIMIT    = 15
$USER_MULT     = 32

# 阶段：起始分钟 / 结束分钟 / 倍率
$P_START = @(0,   5,  10,  20)
$P_END   = @(5,  10,  20, 9999)
$P_MOD   = @(1.0, 1.4, 1.9, 2.5)

# ── 核心：分段积分推进时间 ────────────────────────────────
function Get-PhaseIndex([double]$t) {
    for ($i = 0; $i -lt $P_START.Count; $i++) {
        if ($t -ge $P_START[$i] -and $t -lt $P_END[$i]) { return $i }
    }
    return $P_START.Count - 1
}

function Advance([hashtable]$s, [double]$delta) {
    $remaining = $delta
    $gained    = 0.0
    $guard     = 0
    while ($remaining -gt 1e-9) {
        if (++$guard -gt 1000) { throw "Advance 死循环：cursor=$($s.t)" }
        $i    = Get-PhaseIndex $s.t
        $mod  = $P_MOD[$i] + $s.bonus
        $sev  = $BASE * $mod * $s.mit
        $slice = [Math]::Min($remaining, [double]$P_END[$i] - $s.t)
        $gained += $sev * $slice
        $s.t      = [Math]::Round($s.t + $slice, 6)
        $remaining = [Math]::Round($remaining - $slice, 6)
    }
    $s.impact = [Math]::Round($s.impact + $gained, 4)
    return [Math]::Round($gained, 4)
}

# ── 路径执行器 ───────────────────────────────────────────
# step: @{ n=名称; t=耗时; mit=; bonus=; reset=$true }
function Run-Path([string]$title, [array]$steps, [double]$limit = $INIT_LIMIT) {
    $s = @{ t = 0.0; impact = 0.0; mit = 1.0; bonus = 0.0 }
    $rows = @()
    $i = 1
    foreach ($step in $steps) {
        $inc = Advance $s ([double]$step.t)
        if ($null -ne $step.mit)   { $s.mit   = $step.mit }
        if ($null -ne $step.bonus) { $s.bonus = $s.bonus + $step.bonus }
        if ($step.reset)           { $s.impact = 0 }
        $rows += [PSCustomObject]@{
            回合   = $i
            行动   = $step.n
            时刻   = $s.t
            增量   = $inc
            累计   = $s.impact
        }
        $i++
    }
    Write-Host ""
    Write-Host "── $title " -NoNewline
    Write-Host ("-" * [Math]::Max(1, 46 - $title.Length))
    $rows | Format-Table -AutoSize | Out-String | Write-Host
    $users = [Math]::Round($s.impact * $USER_MULT)
    Write-Host ("  时间 {0}/{1} 分   最终 Impact {2}   受影响用户 {3} 人" -f $s.t, $limit, $s.impact, $users)
    return $s
}

# ── 路径 A · 标准解 ──────────────────────────────────────
$pathA = @(
    @{ n = '看监控大盘';      t = 0 }
    @{ n = '看日志';          t = 1 }
    @{ n = '链路追踪';        t = 2 }
    @{ n = '同步进展';        t = 1 }
    @{ n = '查看上游调用';    t = 2 }
    @{ n = '限流';            t = 1; mit = 0.5 }
    @{ n = '改代码 + 发版';   t = 8 }
)
$rA = Run-Path '路径 A · 标准解（预期 A / 43.95）' $pathA 25

# ── 路径 B · 视界解 ──────────────────────────────────────
$pathB = @(
    @{ n = '看监控大盘';      t = 0 }
    @{ n = '看日志';          t = 1 }
    @{ n = '开启视界';        t = 0 }
    @{ n = '限流';            t = 1; mit = 0.5 }
    @{ n = '改代码 + 发版';   t = 8 }
)
$rB = Run-Path '路径 B · 视界解（预期 S / 21.00）' $pathB

# ── 路径 C · 重启后翻盘 ──────────────────────────────────
$pathC = @(
    @{ n = '看监控大盘';      t = 0 }
    @{ n = '重启服务';        t = 1; bonus = 0.5; reset = $true }
    @{ n = '看日志';          t = 1 }
    @{ n = '限流';            t = 1; mit = 0.5 }
    @{ n = '开启视界';        t = 0 }
    @{ n = '改代码 + 发版';   t = 8 }
)
$rC = Run-Path '路径 C · 重启后翻盘（预期 B / 31.35）' $pathC

# ── 路径 D · 典型失败 ────────────────────────────────────
$pathD = @(
    @{ n = '扩容';            t = 3 }
    @{ n = '翻历史记录';      t = 3 }
    @{ n = '加索引';          t = 5 }
    @{ n = '加缓存';          t = 4 }
)
$rD = Run-Path '路径 D · 典型失败（预期 F / 64.50）' $pathD

# ── 被动失败曲线 ─────────────────────────────────────────
$passive = @{ t = 0.0; impact = 0.0; mit = 1.0; bonus = 0.0 }
$marks = @()
foreach ($m in @(5, 10, 15, 20)) {
    $null = Advance $passive ($m - $passive.t)
    $marks += [PSCustomObject]@{ 时刻 = "$m 分"; 累计Impact = $passive.impact }
}
Write-Host ""
Write-Host "── 被动失败曲线（预期 15.00 / 36.00 / 64.50 / 93.00）"
$marks | Format-Table -AutoSize | Out-String | Write-Host

# ── 跨阶段积分示例（§3.2）───────────────────────────────
$demo = @{ t = 4.0; impact = 0.0; mit = 0.5; bonus = 0.0 }
$demoInc = Advance $demo 8
Write-Host ("── 跨阶段积分示例：t=4 推进 8 分钟，mit=0.5 → {0}（预期 17.70，错误算法会得 12.00）" -f $demoInc)

# ── 系数推导校验 ─────────────────────────────────────────
$coefA = [Math]::Round($rA.impact / $BASE, 3)
$coefB = [Math]::Round($rB.impact / $BASE, 3)
Write-Host ""
Write-Host "── 敏感度系数（预期 A=14.65  B=7.00）"
Write-Host ("   路径 A 系数 = {0}    → A 级上限 base 小于 {1}" -f $coefA, [Math]::Round(50 / $coefA, 2))
Write-Host ("   路径 B 系数 = {0}    → S 级上限 base 小于 {1}" -f $coefB, [Math]::Round(25 / $coefB, 2))

# ── 断言 ─────────────────────────────────────────────────
Write-Host ""
Write-Host "── 一致性检查"
$fail = 0
function Assert-Near($label, $actual, $expect, $tol = 0.05) {
    $ok = [Math]::Abs($actual - $expect) -le $tol
    if (-not $ok) { $script:fail++ }
    $mark = if ($ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("   [{0}] {1,-34} 实际 {2,-9} 预期 {3}" -f $mark, $label, $actual, $expect)
}
Assert-Near 'A 最终 Impact'      $rA.impact 43.95
Assert-Near 'B 最终 Impact'      $rB.impact 21.00
Assert-Near 'C 最终 Impact'      $rC.impact 31.35
Assert-Near 'D 最终 Impact'      $rD.impact 64.50
Assert-Near 'A 系数'             $coefA 14.65 0.01
Assert-Near 'B 系数'             $coefB 7.00  0.01
Assert-Near '跨阶段积分示例'      $demoInc 17.70
Assert-Near 'A 受影响用户'        ([Math]::Round($rA.impact * $USER_MULT)) 1406 1
Assert-Near '被动 t=15'           $marks[2].累计Impact 64.50

Write-Host ""
if ($fail -eq 0) {
    Write-Host "全部通过。" -ForegroundColor Green
} else {
    Write-Host "$fail 项不一致——请检查 06/07/08 三份文档是否同步。" -ForegroundColor Red
    exit 1
}
