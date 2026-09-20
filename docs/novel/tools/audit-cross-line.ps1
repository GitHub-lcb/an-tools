# ============================================================
#  《代码视界》三线一致性交叉校验
#  用途：检查设定集 §3 的视觉映射条目在小说 / 漫剧 / 游戏中的使用情况
#  用法：powershell -ExecutionPolicy Bypass -File audit-cross-line.ps1
#  注意：本文件必须保存为 UTF-8 with BOM。
# ============================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent   # docs\novel

# ── 三条线的文件集 ──────────────────────────────────────
$lines = @{
  '小说' = @('13-','14-','15-','16-','17-','18-','19-','20-','21-')
  '漫剧' = @('23-','24-','25-','26-','27-','28-')
  '游戏' = @('06-','07-','08-','09-','10-','11-','29-')
}

$content = @{}
foreach ($k in $lines.Keys) {
  $buf = New-Object System.Text.StringBuilder
  foreach ($f in Get-ChildItem $root -File) {
    foreach ($pre in $lines[$k]) {
      if ($f.Name.StartsWith($pre)) { [void]$buf.AppendLine((Get-Content -Raw -Encoding UTF8 $f.FullName)) }
    }
  }
  $content[$k] = $buf.ToString()
}

# ── 设定集 §3 的映射条目（关键词用 | 分隔，命中任一即算使用）──
$entries = @(
  # §3.1 基础映射
  @{ s='3.1'; n='单体应用';       k='城堡' }
  @{ s='3.1'; n='微服务';         k='城邦群' }
  @{ s='3.1'; n='网关';           k='城门' }
  @{ s='3.1'; n='服务注册中心';   k='公告板' }
  @{ s='3.1'; n='服务调用链';     k='钢丝绳|缆车' }
  @{ s='3.1'; n='数据库';         k='金库' }
  @{ s='3.1'; n='数据库连接池';   k='五十扇门|连接池' }
  @{ s='3.1'; n='缓存（Redis）';  k='货棚' }
  @{ s='3.1'; n='消息队列（MQ）'; k='传送带|运河' }
  @{ s='3.1'; n='负载均衡';       k='调度员' }
  @{ s='3.1'; n='日志系统';       k='史官|卷轴' }
  @{ s='3.1'; n='链路追踪';       k='红线' }
  # §3.2 人物化映射
  @{ s='3.2'; n='线程';           k='工人' }
  @{ s='3.2'; n='线程池';         k='二十个|线程池' }
  @{ s='3.2'; n='阻塞';           k='BLOCKED|阻塞' }
  @{ s='3.2'; n='死锁';           k='死锁' }
  @{ s='3.2'; n='线程饥饿';       k='饥饿' }
  @{ s='3.2'; n='忙等待（自旋）'; k='自旋|跺脚' }
  @{ s='3.2'; n='单例';           k='唯一的城主|只有一个城主|全城只有一个人' }  # 原为 '城主'——过宽，会被 EP32「城主签了字」误命中
  @{ s='3.2'; n='代理模式';       k='影武者' }
  @{ s='3.2'; n='观察者模式';     k='钟声' }
  @{ s='3.2'; n='GC 垃圾回收';    k='收尸人|麻袋' }
  # §3.3 灾难化映射
  @{ s='3.3'; n='慢 SQL';         k='慢 SQL|慢SQL' }
  @{ s='3.3'; n='全表扫描';       k='全表扫描' }
  @{ s='3.3'; n='缺索引';         k='目录卡' }
  @{ s='3.3'; n='内存泄漏';       k='内存泄漏|泄漏' }
  @{ s='3.3'; n='Full GC / STW';  k='STW|全城静止|静止之城' }
  @{ s='3.3'; n='OOM';            k='OOM|内存溢出' }
  @{ s='3.3'; n='缓存击穿';       k='击穿' }
  @{ s='3.3'; n='缓存雪崩';       k='雪崩|决堤' }
  @{ s='3.3'; n='缓存穿透';       k='穿透' }
  @{ s='3.3'; n='布隆过滤器';     k='布隆|验票员' }
  @{ s='3.3'; n='幂等';           k='幂等' }
  @{ s='3.3'; n='分布式事务';     k='分布式事务|契约悬空|城主.{0,4}签' }  # 补视觉语言关键词：设定集映射是「多个城主同时签字」，纯术语会让"提到即算用过"
  @{ s='3.3'; n='消息积压';       k='消息积压|积压' }
  @{ s='3.3'; n='熔断';           k='熔断|吊桥' }
  @{ s='3.3'; n='限流';           k='限流|令牌桶|闸机' }
  @{ s='3.3'; n='服务雪崩';       k='服务雪崩|多米诺' }
  @{ s='3.3'; n='主从延迟';       k='主从' }
  @{ s='3.3'; n='分布式锁';       k='分布式锁' }
  @{ s='3.3'; n='脑裂';           k='脑裂' }
  @{ s='3.3'; n='技术债';         k='技术债|违章搭建' }
  @{ s='3.3'; n='祖传代码';       k='祖传|老宅|别碰这里' }
  @{ s='3.3'; n='Git 冲突';       k='Git 冲突|代码冲突' }
  @{ s='3.3'; n='回滚';           k='回滚' }
  @{ s='3.3'; n='灰度发布';       k='灰度' }
  @{ s='3.3'; n='单元测试';       k='单元测试' }
  @{ s='3.3'; n='CI/CD 流水线';   k='CI/CD|流水线' }
)

# ── 逐条检查 ────────────────────────────────────────────
$rows = @()
foreach ($e in $entries) {
  $r = [ordered]@{ 节 = $e.s; 映射条目 = $e.n }
  foreach ($k in @('小说','漫剧','游戏')) {
    $hit = $false
    foreach ($kw in ($e.k -split '\|')) {
      if ($content[$k] -match [regex]::Escape($kw)) { $hit = $true; break }
    }
    $r[$k] = if ($hit) { '✅' } else { '—' }
  }
  $cnt = @($r['小说'],$r['漫剧'],$r['游戏']) | Where-Object { $_ -eq '✅' } | Measure-Object | Select-Object -ExpandProperty Count
  $r['线数'] = $cnt
  $rows += [PSCustomObject]$r
}

Write-Host ""
Write-Host "═══ 三线使用情况明细 ═══"
$rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

# ── 汇总 ────────────────────────────────────────────────
function Get-Cell($row, $key) { return $row.PSObject.Properties[$key].Value }
function Get-Lines($row) {
  return @(@('小说','漫剧','游戏') | Where-Object { (Get-Cell $row $_) -eq '✅' })
}

Write-Host "═══ 汇总 ═══"
Write-Host ("  条目总数：{0}" -f $rows.Count)
foreach ($k in @('小说','漫剧','游戏')) {
  $c = @($rows | Where-Object { (Get-Cell $_ $k) -eq '✅' }).Count
  Write-Host ("  {0}使用：{1} 条 ({2:N0}%)" -f $k, $c, ($c / $rows.Count * 100))
}
Write-Host ""
Write-Host ("  三线全覆盖：{0} 条" -f (@($rows | Where-Object { $_.线数 -eq 3 }).Count))
Write-Host ("  两线使用  ：{0} 条" -f (@($rows | Where-Object { $_.线数 -eq 2 }).Count))
Write-Host ("  单线使用  ：{0} 条" -f (@($rows | Where-Object { $_.线数 -eq 1 }).Count))
Write-Host ("  完全未用  ：{0} 条" -f (@($rows | Where-Object { $_.线数 -eq 0 }).Count))

$unused = @($rows | Where-Object { $_.线数 -eq 0 })
if ($unused.Count -gt 0) {
  Write-Host ""
  Write-Host "═══ ⚠️ 设定集里躺着、三线都没用上的条目 ═══" -ForegroundColor Yellow
  $unused | ForEach-Object { "  [{0}] {1}" -f $_.节, $_.映射条目 }
}

$single = @($rows | Where-Object { $_.线数 -eq 1 })
if ($single.Count -gt 0) {
  Write-Host ""
  Write-Host "═══ ⚠️ 只在一线出现（改编时可能断层）═══" -ForegroundColor Yellow
  foreach ($r in $single) {
    "  [{0}] {1}  →  仅 {2}" -f $r.节, $r.映射条目, ((Get-Lines $r) -join '')
  }
}

Write-Host ""
Write-Host "═══ 结论 ═══"
$unusedPct = [Math]::Round($unused.Count / $rows.Count * 100, 0)
if ($unused.Count -eq 0) {
  Write-Host "  ✅ 设定集所有映射条目均已被至少一条产品线使用。" -ForegroundColor Green
} else {
  Write-Host ("  ⚠️ {0} 条（{1}%）从未被使用——要么补，要么从设定集删除。" -f $unused.Count, $unusedPct) -ForegroundColor Yellow
}
