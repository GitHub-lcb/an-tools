# ============================================================
#  LEVEL 3《静止之城》· 数值参考实现与验算脚本
#  用途：复核 29-LEVEL3-静止之城-完整规格.md 的全部数值
#  用法：powershell -ExecutionPolicy Bypass -File verify-balance-l3.ps1
#  注意：本文件必须保存为 UTF-8 with BOM。
#
#  本脚本修复了 29 号文档中的三处数值错误：
#    · §5.1 路径 A 表格给 62.6（未应用限流的缓解系数，且时间列不连续）
#    · §7.2 逐段验算给 55.8（同样漏算缓解系数）
#    · 两处互相矛盾，且都与正确的卡牌序列不符
# ============================================================

$ErrorActionPreference = 'Stop'

# ── 常量 ────────────────────────────────────────────────
$IMPACT_MAX   = 150
$TIME_LIMIT   = 60
$CYCLE_LEN    = 10      # 一个完整周期
$STALL_LEN    = 3       # 周期内的卡顿期
$STALL_SEV    = 4.0     # 卡顿期 Impact 增速
$CALM_SEV     = 0.3     # 平静期 Impact 增速
$HEAP_INIT    = 60
$HEAP_GROWTH  = 8       # 每个卡顿期结束时的增长
$HEAP_RESTART = 60      # 重启后回落值
$RESTART_MULT = 1.5     # 重启后增长倍率
$USER_MULT    = 24      # Impact -> 受影响请求数
$STEP         = 0.02    # 积分步长（分钟），不可放大

function Test-Stall([double]$t) {
  return (($t % $CYCLE_LEN) -lt $STALL_LEN)
}

function Get-Severity([double]$t, [double]$mit) {
  $base = if (Test-Stall $t) { $STALL_SEV } else { $CALM_SEV }
  return $base * $mit
}

function New-State {
  return @{
    t = 0.0; impact = 0.0; heap = [double]$HEAP_INIT
    mit = 1.0; growth = [double]$HEAP_GROWTH
    restarts = 0; lastStallEnd = 0
    oom = $false; oomAt = $null; maxHeap = [double]$HEAP_INIT
  }
}

# 推进时间：结算 Impact 与堆内存
function Advance-L3($s, [double]$delta) {
  $remaining = $delta
  $guard = 0
  while ($remaining -gt 1e-9 -and -not $s.oom) {
    if (++$guard -gt 200000) { throw "Advance 死循环" }
    $slice = [Math]::Min($remaining, $STEP)
    $t0 = $s.t
    $t1 = [Math]::Round($t0 + $slice, 6)

    # Impact
    $s.impact += (Get-Severity $t0 $s.mit) * $slice

    # 卡顿期结束时，堆内存增长
    # 卡顿期结束时刻：t % 10 == 3  →  3, 13, 23, 33, 43, 53
    $cycleStart = [Math]::Floor($t0 / $CYCLE_LEN) * $CYCLE_LEN
    $stallEnd = $cycleStart + $STALL_LEN
    if ($t0 -lt $stallEnd -and $t1 -ge $stallEnd -and $s.lastStallEnd -lt $stallEnd) {
      $s.heap += $s.growth
      $s.lastStallEnd = $stallEnd
      if ($s.heap -gt $s.maxHeap) { $s.maxHeap = $s.heap }
      if ($s.heap -ge 100) {
        $s.heap = 100; $s.oom = $true; $s.oomAt = $stallEnd
      }
    }

    $s.t = $t1
    $remaining = [Math]::Round($remaining - $slice, 6)
  }
  $s.impact = [Math]::Round($s.impact, 4)
  if ($s.heap -gt $s.maxHeap) { $s.maxHeap = $s.heap }
}

function Run-L3([string]$title, [array]$steps, [double]$limit = $TIME_LIMIT) {
  $s = New-State
  $rows = @()
  $i = 1
  foreach ($st in $steps) {
    if ($s.oom) { break }
    Advance-L3 $s ([double]$st.t)
    if ($null -ne $st.mit)     { $s.mit = $st.mit }
    if ($null -ne $st.mitMul)  { $s.mit = [Math]::Round($s.mit * $st.mitMul, 4) }
    if ($st.restart) {
      $s.restarts += 1
      $s.heap = [double]$HEAP_RESTART
      $s.growth = [Math]::Round($s.growth * $RESTART_MULT, 4)
    }
    if ($st.gcTune) {
      $s.heap = [Math]::Max(0, $s.heap - 15)
      $s.growth = [Math]::Round($s.growth * 0.7, 4)
    }
    $rows += [PSCustomObject]@{
      回合 = $i; 行动 = $st.n; 时刻 = $s.t
      Impact = $s.impact; 堆 = $s.heap
      阶段 = $(if (Test-Stall $s.t) { '卡顿' } else { '平静' })
    }
    $i++
  }
  Write-Host ""
  Write-Host "── $title " -NoNewline
  Write-Host ("-" * [Math]::Max(1, 42 - $title.Length))
  $rows | Format-Table -AutoSize | Out-String | Write-Host
  if ($s.oom) {
    Write-Host ("  >> 堆内存在 t = {0} 分钟达到 100 → OOM（立即失败）" -f $s.oomAt) -ForegroundColor Red
  } else {
    Write-Host ("  时间 {0} 分   Impact {1}   堆 {2}   堆峰值 {3}" -f $s.t, $s.impact, $s.heap, $s.maxHeap)
  }
  return $s
}

# ── 被动失败（不操作，推进到 60 分钟或 OOM）──────────────
$passive = New-State
$marks = @()
foreach ($m in @(3, 13, 23, 33, 43, 60)) {
  if (-not $passive.oom -and $m -gt $passive.t) { Advance-L3 $passive ($m - $passive.t) }
  $marks += [PSCustomObject]@{ 时刻 = $m; Impact = $passive.impact; 堆 = $passive.heap }
}
Write-Host ""
Write-Host "── 被动失败曲线"
$marks | Format-Table -AutoSize | Out-String | Write-Host
if ($passive.oom) {
  Write-Host ("  >> 被动玩家在 t = {0} 分钟 OOM，此时 Impact = {1}" -f $passive.oomAt, $passive.impact) -ForegroundColor Red
}

# ── 路径 A · 标准解 ─────────────────────────────────────
$rA = Run-L3 '路径 A · 标准解' @(
    @{ n = '看监控大盘';        t = 0 }
    @{ n = '看 GC 日志';        t = 2 }
    @{ n = '等（跳过）';        t = 1 }
    @{ n = '导出堆快照';        t = 4 }
    @{ n = '扫描缓存对象';      t = 3 }
    @{ n = '同步进展';          t = 1 }
    @{ n = '限流';              t = 1; mit = 0.5 }
    @{ n = '等（跳过）';        t = 8 }
    @{ n = '改代码 + 发版';     t = 8 }
)

# ── 路径 A+ · 算准发版时机（等卡顿期结束再发版）─────────
$rAplus = Run-L3 '路径 A+ · 算准发版时机' @(
    @{ n = '看监控大盘';        t = 0 }
    @{ n = '看 GC 日志';        t = 2 }
    @{ n = '等（跳过）';        t = 1 }
    @{ n = '导出堆快照';        t = 4 }
    @{ n = '扫描缓存对象';      t = 3 }
    @{ n = '同步进展';          t = 1 }
    @{ n = '限流';              t = 1; mit = 0.5 }
    @{ n = '等（等卡顿期结束）'; t = 1 }
    @{ n = '改代码 + 发版';     t = 8 }
)

# ── 路径 B · 视界解 ─────────────────────────────────────
$rB = Run-L3 '路径 B · 视界解' @(
    @{ n = '看监控大盘';        t = 0 }
    @{ n = '看 GC 日志';        t = 2 }
    @{ n = '开启视界';          t = 0 }
    @{ n = '等（跳过）';        t = 1 }
    @{ n = '限流';              t = 1; mit = 0.5 }
    @{ n = '改代码 + 发版';     t = 8 }
)

# ── 路径 C · 重启后翻盘 ─────────────────────────────────
$rC = Run-L3 '路径 C · 重启后翻盘' @(
    @{ n = '看监控大盘';        t = 0 }
    @{ n = '重启服务';          t = 1; restart = $true }
    @{ n = '看 GC 日志';        t = 2 }
    @{ n = '开启视界';          t = 0 }
    @{ n = '限流';              t = 1; mit = 0.5 }
    @{ n = '改代码 + 发版';     t = 8 }
)

# ── 路径 D · 饮鸩止渴 ───────────────────────────────────
$rD = Run-L3 '路径 D · 饮鸩止渴（调大堆内存后一直等）' @(
    @{ n = '调大堆内存';        t = 3; gcTune = $true }
    @{ n = '等（跳过）';        t = 57 }
)

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
Assert-Near '被动 OOM 时刻'        $passive.oomAt 43 0.1
Assert-Near '被动 t=40 时 Impact'   ($marks | Where-Object { $_.时刻 -eq 33 }).Impact 54.3
Assert-Near '被动 t=33 时堆'        ($marks | Where-Object { $_.时刻 -eq 33 }).堆 92
Assert-Near 'A 最终 Impact'         $rA.impact 31.9
Assert-Near 'A 最终堆'              $rA.heap 84
Assert-Near 'A+ 最终 Impact'        $rAplus.impact 27.15
Assert-Near 'A+ 最终堆'             $rAplus.heap 76
Assert-Near 'B 最终 Impact'         $rB.impact 17.2
Assert-Near 'B 最终堆'              $rB.heap 68
Assert-Near 'C 最终 Impact'         $rC.impact 17.2
Assert-Near 'C 最终堆'              $rC.heap 72
Assert-Near 'C 重启次数'            $rC.restarts 1
Assert-Near 'D 最终 Impact'         $rD.impact 84.6
Assert-Near 'D 未 OOM'              ($(if ($rD.oom) { 1 } else { 0 })) 0 0
Assert-Near 'A 未 OOM'              ($(if ($rA.oom) { 1 } else { 0 })) 0 0

Write-Host ""
if ($fail -eq 0) { Write-Host "全部通过。" -ForegroundColor Green }
else { Write-Host "$fail 项不一致——请检查 29 号文档。" -ForegroundColor Red; exit 1 }
