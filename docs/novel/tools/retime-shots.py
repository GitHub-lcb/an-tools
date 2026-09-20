# -*- coding: utf-8 -*-
"""
retime-shots.py —— 分镜表时码重排工具
================================================================
口径（2026-09-20 定，依据见 00-项目索引与路线图.md §5.1）：

  1. 每集标题的「**N 秒**」是权威总时长。依据三重：
     - `22` 分集总表逐集列出该秒数，且 §零/§145 记「40 集约 80–82 分钟」
     - `31` 对外的 EP19 = 145 秒 / 88 个镜头
     - 对白时长物理可行（全季对白+静音下限 44 分钟 < 标题总长 82 分钟）
  2. 表格的累计时间码是错的（全季 214 分钟，EP19 单集跑到 15:30）。
  3. 重排算法 —— 内容驱动，不是等比缩放：
     每镜下限 = max(1s, 对白字数/5.0, 「静音 N 秒」之和)
     招牌镜头钉死（EP09 第 9 镜 = 60 秒长镜头，`31` 承诺）
     余量按原镜长比例加权分配（保留作者的重音分布）
  4. 若某集 sum(下限) > 标题秒数：该集物理超载，时码按内容下限重排，
     并在标题下插入超载提示。

用法：
    python retime-shots.py            # 预览，不写盘
    python retime-shots.py --write    # 落盘
"""
import re, os, sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FILES = ["23-漫剧脚本-EP01-EP06.md", "24-漫剧脚本-EP07-EP12.md",
         "25-漫剧脚本-EP13-EP19.md", "26-漫剧脚本-EP20-EP28.md",
         "27-漫剧脚本-EP29-EP36.md", "28-漫剧脚本-EP37-EP40.md"]

WRITE = "--write" in sys.argv
RATE = 5.0                       # 中文对白速率：字/秒
PIN = {("09", 9): 60}            # 招牌长镜头：EP09 第 9 镜

ep_re   = re.compile(r'^##\s*EP(\d+)\s*[·\-—]\s*(.+?)\s*$')
sec_re  = re.compile(r'^\*\*(\d+)\s*秒')
end_re  = re.compile(r'^\*\*本集制作要点')
flag_re = re.compile(r'^> ⚠️ \*\*本集物理超载\*\*')
row_re  = re.compile(r'^\|\s*(\d+)\s*\|\s*(\d+):(\d{2})\s*[–\-—~]\s*(\d+):(\d{2})\s*\|')
tc_re   = re.compile(r'(\d+):(\d{2})\s*[–\-—~]\s*(\d+):(\d{2})')
quo_re  = re.compile(r'「([^」]*)」')
cn_re   = re.compile(r'[\u4e00-\u9fff]')
sil_re  = re.compile(r'静音\s*(\d+)\s*秒')
sec_any = re.compile(r'(\d+(?:\.\d+)?)\s*秒')        # 行内任何「N 秒」都是该镜的时长声明


def speech_sec(sound):
    q = quo_re.findall(sound)
    if q:
        return sum(len(cn_re.findall(x)) for x in q) / RATE
    if '旁白' in sound:
        tail = sound.split('旁白', 1)[1]
        return len(cn_re.findall(quo_re.sub(lambda m: m.group(1), tail))) / RATE
    return 0.0


def floor_of(line, ep, idx):
    """该镜的物理下限：对白时长、「静音 N 秒」节拍、以及行内任何「N 秒」时长声明，三者取大。
    返回 (下限, 是否受标注保护)。受保护的镜头取精确值，不再参与余量分配。"""
    parts = line.split('|')
    sound = parts[4] if len(parts) > 4 else ''
    text = (parts[3] if len(parts) > 3 else '') + sound
    sp = speech_sec(sound)
    si = sum(int(x) for x in sil_re.findall(sound))
    mentioned = [float(x) for x in sec_any.findall(text)]
    stated = float(-(-max(mentioned) // 1)) if mentioned else 0.0   # 标注值向上取整
    m = max(1.0, sp + si, stated)
    pin = PIN.get((f"{ep:02d}", idx))
    if pin:
        m = max(m, float(pin))
    annot = bool(mentioned) or si > 0 or pin is not None
    return m, annot


def allocate(mins, weights, pins, T):
    """每镜至少 ceil(min)；pinned 钉死；余量按 weights 加权，最大余数法，总和恰为 T。"""
    lows = [max(1, int(m)) for m in mins]            # 先取下界，至少 1 秒
    fixed = list(lows)
    surplus = T - sum(lows)
    if surplus < 0:
        return fixed, False
    pool = [i for i in range(len(mins)) if not pins[i]]
    if pool:
        W = sum(weights[i] for i in pool) or 1
        raw = {i: surplus * weights[i] / W for i in pool}
        for i in pool:
            fixed[i] += int(raw[i])
        left = T - sum(fixed)
        order = sorted(pool, key=lambda i: -(raw[i] - int(raw[i])))
        for k in range(left):
            fixed[order[k % len(order)]] += 1
    return fixed, True


def fmt(s):
    return f"{s // 60}:{s % 60:02d}"


report = []
for f in FILES:
    path = os.path.join(BASE, f)
    lines = open(path, encoding='utf-8').read().split('\n')
    out = list(lines)
    i = 0
    inserts = []
    while i < len(lines):
        m = ep_re.match(lines[i])
        if not m:
            i += 1
            continue
        ep = int(m.group(1))
        # 标题秒数
        title_s, tline = None, None
        j = i + 1
        while j < len(lines):
            if sec_re.match(lines[j]) and title_s is None:
                title_s = int(sec_re.match(lines[j]).group(1))
                tline = j
            if row_re.match(lines[j]) or end_re.match(lines[j]) or ep_re.match(lines[j]):
                break
            j += 1
        # 表格行
        rows = []
        k = j
        while k < len(lines):
            if end_re.match(lines[k]) or ep_re.match(lines[k]):
                break
            r = row_re.match(lines[k])
            if r:
                st = int(r.group(2)) * 60 + int(r.group(3))
                en = int(r.group(4)) * 60 + int(r.group(5))
                sound = lines[k].split('|')[4] if len(lines[k].split('|')) > 4 else ''
                idx = int(r.group(1))
                mn, annot = floor_of(lines[k], ep, idx)
                rows.append([k, idx, max(1, en - st), mn, annot, sound])
            k += 1
        if title_s and rows:
            mins = [r[3] for r in rows]
            weights = [r[2] for r in rows]
            annot = [r[4] for r in rows]
            need_f = sum(mins)
            overload = need_f > title_s + 1e-6
            T = int(-(-need_f // 1)) if overload else title_s   # 超载时取内容下限的整数上界
            need = T
            alloc, _ = allocate(mins, weights, annot, T)
            cum = 0
            for r, nd in zip(rows, alloc):
                a, b = cum, cum + nd
                cum = b
                out[r[0]] = tc_re.sub(f"{fmt(a)}–{fmt(b)}", out[r[0]], count=1)
            # 超载提示
            if overload:
                sp = sum(speech_sec(r[5]) for r in rows)
                si = sum(sum(int(x) for x in sil_re.findall(r[5])) for r in rows)
                msg = (f"> ⚠️ **本集物理超载**：逐镜内容下限合计 **{need} 秒**"
                       f"（对白 ≈{sp:.0f}s、静音节拍 {si}s、共 {len(rows)} 镜；逐镜下限 = 对白时长 + 静音节拍，取大不小于 1s），"
                       f"标题 **{title_s} 秒**装不下。下表时码已按 **{need} 秒**重排；**建议拆集或加时**（见 `31-对外提案文档.md` §10.2）。")
                already = tline + 1 < len(lines) and flag_re.match(lines[tline + 1])
                if not already:
                    inserts.append((tline + 1, msg))
            report.append((f, ep, title_s, len(rows), need, T, overload))
        i = k + 1
    for pos, msg in sorted(inserts, reverse=True):
        out.insert(pos, msg)
        out.insert(pos + 1, '')
    if WRITE and report:
        open(path, 'w', encoding='utf-8', newline='\n').write('\n'.join(out))

print("EP | 标题 | 镜数 | 内容下限 | 采用总长 | 状态")
print("-" * 60)
for f, ep, ts, n, need, T, ov in report:
    print(f"EP{ep:02d} | {ts:>4}s | {n:>3} | {need:>7}s | {T:>7}s | {'超载(按下限)' if ov else 'OK'}")
tot = sum(r[5] for r in report)
print("-" * 60)
print(f"40 集合计 {tot}s = {tot/60:.1f} 分钟   （标题口径 {sum(r[2] for r in report)}s）")
print(f"超载集：{[f'EP{r[1]:02d}' for r in report if r[6]]}")
