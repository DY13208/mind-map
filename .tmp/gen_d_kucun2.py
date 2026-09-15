#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 D：库存周转 执行单（HTML）+ 渠道库存周转监控表（Excel）。
数据源：mind-map MCP room-xgoibqb8 v257（实时读取）。
原则：无数值来源 → 不伪造；数值列留空待回填。"""
import os, html
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

TS = "2026-09-14_1653"
STAMP = "2026-09-14 16:53"
OUT = r"D:\liangce\mind-map\output"
os.makedirs(OUT, exist_ok=True)

# 渠道字典（room-xgoibqb8 渠道编码口径；17 店铺编号）
CH = [
    ("个护部", "天猫", "个护部天猫UNOVE柔诺伊官方旗舰店", "13CHAN10030"),
    ("个护部", "天猫国际", "个护部天猫UNOVE海外旗舰店", "13CHAN10039"),
    ("直播组", "抖音", "直播组抖音UNOVE柔诺伊官方旗舰店", "13CHAN10132"),
    ("直播组", "抖音", "直播组抖音UNOVE柔诺伊个人护理旗舰店", "13CHAN10029"),
    ("直播组", "快手", "直播组快手UNOVE柔诺伊旗舰店", "13CHAN10033"),
    ("直播组", "小红书", "直播组小红书UNOVE柔诺伊旗舰店", "13CHAN10041"),
    ("直供组", "天猫超市", "直供组天猫超市供货-UNOVE", "13CHAN40025-04"),
    ("直供组", "京东", "直供组商务UNOVE京东自营旗舰店", "13CHAN10100"),
    ("直供组", "京东", "赛燃UNOVE海外京东自营旗舰店", "SAIRAN0021"),
    ("直供组", "得物", "得物大贸UNOVE", "XXJ019"),
    ("零售组", "拼多多", "零售组拼多多UNOVE柔诺伊美容护发旗舰店", "13CHAN10048"),
    ("面护部", "唯品会", "面护部唯品会大贸-UNOVE", "13CHAN10122"),
    ("外贸组", "外贸分销", "外贸组UNOVE分销", "XXJ003"),
    ("分销组", "分销", "分销组UNOVE", "13CHAN10058"),
    ("线下组", "线下", "线下组UNOVE", "13CHAN10084"),
    ("直供组", "直供分销-回款", "直供组UNOVE分销-回款", "XXJ025"),
    ("KA组", "KA分销", "KA组UNOVE分销", "13CHAN50135"),
]

STEPS = [
    ("1", "渠道库存周转监控（责任：陈华俊）", "对全部 17 个渠道门店盘点库存与周转情况", "陈华俊", "周期制", "待执行"),
    ("2", "ERP 取数：吉客云 销售单明细账 &amp; 分仓库存查询", "按渠道/店铺拉取库存量与出库流水，作为周转计算底表", "ERP 系统 / 陈华俊", "取数", "阻塞：登录授权"),
    ("3", "WORKBUDDY：生成库存周转报告", "汇总各渠道周转天数，自动分档并出报告", "WorkBuddy", "按次", "待喂数"),
    ("4", "库存周转进度 · 判定", "分「超周转」与「周转正常」两类", "陈华俊", "按次", "待判定"),
    ("5", "超周转 → 预期周转正常时间", "对超周转渠道测算清库/转正常时点", "陈华俊", "按次", "待判定"),
    ("6", "超周转 → 渠道销售提升计划", "对超周转渠道给出促销/分销消化动作", "陈华俊", "按次", "待判定"),
    ("7", "周转正常 → 保持销售", "周转正常渠道维持当前销售节奏", "陈华俊", "持续", "待判定"),
    ("8", "财务：月度库存管理报表", "财务侧月度库存报表，与渠道侧口径对齐", "财务", "月度", "阻塞：登录墙"),
]

CALIBER = [
    ("超周转", "周转天数高于约定阈值（阈值口径缺失，需企微文档/ERP 补充）", "测算「预期周转正常时间」并制定「渠道销售提升计划」", "ERP 吉客云 + 财务月报"),
    ("周转正常", "周转天数在约定阈值内", "执行「保持销售」，维持节奏", "ERP 吉客云 + 财务月报"),
    ("待判定", "数据未取到 / 阈值未确认", "先取数、再确认阈值，暂不判档", "—（当前状态）"),
]

ACTIONS = [
    "【取数】开通/登录 ERP 吉客云，导出「销售单明细账」与「分仓库存查询」，覆盖上述 17 个渠道门店。",
    "【对标】在财务「月度库存管理报表」（企业微信微盘，需登录）中确认各渠道库存金额与周转天数口径。",
    "【定阈值】确认「超周转」的周转天数阈值（当前导图无阈值定义，需业务补充），否则无法自动判档。",
    "【报表】上游数据到位后，用 WorkBuddy 生成「库存周转报告」，输出超周转/周转正常分档清单。",
    "【动作】对超周转渠道逐个给出「预期周转正常时间」+「渠道销售提升计划」；周转正常渠道标注「保持销售」。",
    "【对齐】渠道侧监控结果与财务月度报表做一致性核对，避免口径差异。",
]

# ---------------- HTML ----------------
rows_ch = "\n".join(
    f'<tr><td>{g}</td><td>{c}</td><td>{s}</td><td class="mono">{code}</td><td class="c muted">待判定</td></tr>'
    for g, c, s, code in CH)
rows_step = "\n".join(
    f'<tr><td class="c">{n}</td><td>{a}</td><td>{d}</td><td>{who}</td><td class="c">{fq}</td><td class="c st">{st}</td></tr>'
    for n, a, d, who, fq, st in STEPS)
rows_cal = "\n".join(
    f'<tr><td><span class="tag">{s}</span></td><td>{cond}</td><td>{act}</td><td class="muted">{src}</td></tr>'
    for s, cond, act, src in CALIBER)
act_html = "\n".join(f"<li>{a}</li>" for a in ACTIONS)

HTML = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>D：库存周转 执行单 · room-xgoibqb8</title>
<style>
  *{{box-sizing:border-box;margin:0;padding:0}}
  body{{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:#f4f6fb;color:#1f2733;line-height:1.6;padding:28px 18px}}
  .wrap{{max-width:1080px;margin:0 auto}}
  .hd{{background:linear-gradient(120deg,#3b5bdb 0%,#7048e8 60%,#9775fa 100%);
    color:#fff;border-radius:18px;padding:26px 30px;box-shadow:0 10px 30px rgba(60,80,200,.25)}}
  .hd h1{{font-size:24px;letter-spacing:.5px}}
  .hd .sub{{opacity:.92;margin-top:8px;font-size:13.5px}}
  .hd .meta{{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}}
  .hd .chip{{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.35);
    padding:4px 12px;border-radius:999px;font-size:12.5px}}
  .alert{{margin-top:18px;background:#fff5f5;border:1px solid #ffc9c9;border-left:5px solid #fa5252;
    border-radius:12px;padding:16px 20px;font-size:13.5px;color:#8a1c1c}}
  .alert b{{color:#c92a2a}}
  .kpis{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:18px}}
  .kpi{{background:#fff;border-radius:14px;padding:18px 16px;border:1px solid #e9edf5;
    box-shadow:0 4px 14px rgba(30,50,90,.05);border-top:4px solid #adb5bd}}
  .kpi .kpi-v{{font-size:26px;font-weight:700;letter-spacing:.5px}}
  .kpi .kpi-l{{font-size:14px;font-weight:600;margin-top:4px}}
  .kpi .kpi-s{{font-size:11.5px;color:#7b8794;margin-top:6px}}
  .b-blue{{border-top-color:#4c6ef5}} .b-blue .kpi-v{{color:#3b5bdb}}
  .b-red{{border-top-color:#fa5252}} .b-red .kpi-v{{color:#e03131}}
  .b-amber{{border-top-color:#f59f00}} .b-amber .kpi-v{{color:#e8590c}}
  .b-green{{border-top-color:#2f9e44}} .b-green .kpi-v{{color:#2f9e44}}
  .sec{{background:#fff;border-radius:16px;padding:22px 24px;margin-top:18px;
    border:1px solid #e9edf5;box-shadow:0 4px 14px rgba(30,50,90,.05)}}
  .sec h2{{font-size:16px;margin-bottom:14px;padding-left:12px;border-left:4px solid #4c6ef5}}
  table{{width:100%;border-collapse:collapse;font-size:13px}}
  th,td{{text-align:left;padding:10px 12px;border-bottom:1px solid #eef1f7;vertical-align:top}}
  th{{background:#f7f9fd;color:#4a5568;font-weight:600;font-size:12.5px}}
  tr:hover td{{background:#fafbff}}
  .c{{text-align:center}} .muted{{color:#98a2b3}} .mono{{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}}
  .st{{font-weight:600;color:#e8590c}}
  .tag{{display:inline-block;background:#eef2ff;color:#3b5bdb;border-radius:6px;padding:2px 10px;font-weight:600;font-size:12.5px}}
  ol.act{{margin-left:20px}} ol.act li{{margin:8px 0;font-size:13.5px}}
  .foot{{margin-top:18px;font-size:12px;color:#7b8794;line-height:1.9}}
  .foot b{{color:#4a5568}}
  @media(max-width:760px){{.kpis{{grid-template-columns:repeat(2,1fr)}}}}
</style>
</head>
<body>
<div class="wrap">
  <div class="hd">
    <h1>D：库存周转 · 执行单</h1>
    <div class="sub">渠道库存周转监控 → ERP 取数（吉客云）→ WorkBuddy 生成库存周转报告 → 财务月度库存管理报表</div>
    <div class="meta">
      <span class="chip">房间 room-xgoibqb8 · UN项目工程 (v257)</span>
      <span class="chip">分支 P：购销存循环</span>
      <span class="chip">责任人 陈华俊</span>
      <span class="chip">节点 uid efb26842…afd5</span>
      <span class="chip">生成 {STAMP}</span>
    </div>
  </div>

  <div class="alert">
    <b>⚠ 关键数据缺口（本次判定：未完成 / 待补数）</b>：本 SOP 的两个数据源均为登录墙——① <b>ERP 吉客云</b>（销售单明细账 &amp; 分仓库存查询）需账号授权登录；
    ② <b>财务月度库存管理报表</b>为<b>企业微信微盘链接</b>（<span class="mono">https://drive.weixin.qq.com/s?k=ALwAJwfTAAgOKrqv9m</span>），匿名访问仅返回登录壳页（标题「库存管理报表2026年」，HTTP 200 / 0 字节数据）。
    导图 D 子树内亦<b>无任何库存数值</b>、<b>无「超周转」周转天数阈值定义</b>。因此本次<b>不填任何库存数值、不伪造数字</b>，按真实流程与口径出具执行单，待取数后回填。
  </div>

  <div class="kpis">
    <div class="kpi b-blue"><div class="kpi-v">17</div><div class="kpi-l">监控渠道门店</div><div class="kpi-s">7 个渠道组 / 17 个店铺编号</div></div>
    <div class="kpi b-red"><div class="kpi-v">0 / 2</div><div class="kpi-l">数据源接入</div><div class="kpi-s">ERP 吉客云、财务月度报表 均未授权取数</div></div>
    <div class="kpi b-amber"><div class="kpi-v">待取数</div><div class="kpi-l">超周转渠道</div><div class="kpi-s">需库存周转天数与阈值口径</div></div>
    <div class="kpi b-green"><div class="kpi-v">待取数</div><div class="kpi-l">周转正常渠道</div><div class="kpi-s">判定后标注「保持销售」动作</div></div>
  </div>

  <div class="sec">
    <h2>SOP 步骤与检查项</h2>
    <table>
      <tr><th class="c" style="width:44px">#</th><th>动作</th><th>说明</th><th style="width:120px">责任人/系统</th><th class="c" style="width:70px">频率</th><th class="c" style="width:110px">状态</th></tr>
      {rows_step}
    </table>
  </div>

  <div class="sec">
    <h2>判定口径（周转进度分档）</h2>
    <table>
      <tr><th style="width:110px">状态</th><th>触发条件</th><th>对应动作</th><th style="width:190px">数据来源</th></tr>
      {rows_cal}
    </table>
    <p class="foot" style="margin-top:12px">说明：周转天数口径建议＝期间库存量 ÷ 期间日均出库量（需以财务月报/ERP 实际字段为准）；「超周转」阈值须由业务确认后写入本单。</p>
  </div>

  <div class="sec">
    <h2>监控范围（渠道 / 店铺）· 共 17 个店铺编号</h2>
    <table>
      <tr><th style="width:110px">渠道组</th><th style="width:120px">渠道</th><th>店铺名称</th><th style="width:150px">店铺编号</th><th class="c" style="width:90px">周转状态</th></tr>
      {rows_ch}
    </table>
  </div>

  <div class="sec">
    <h2>本周动作（取数 → 判档 → 动作）</h2>
    <ol class="act">
      {act_html}
    </ol>
  </div>

  <div class="foot">
    <b>数据来源</b>：mind-map MCP（room-xgoibqb8 <b>v257</b>，{STAMP} 实时读取）读取「D：库存周转」efb26842 子树（11 节点，全部为流程骨架、无 note/无 hyperlink/无数值），及房间内「渠道编码」字典（渠道定义和统计维度 cbd9f127 + 房间内其它渠道字典副本）确定 17 个店铺编号。<br>
    <b>外部数据源</b>：ERP 吉客云（登录授权）；财务月度库存管理报表 drive.weixin.qq.com/s?k=ALwAJwfTAAgOKrqv9m（企业微信微盘，登录墙）。<br>
    <b>缺口清单</b>：①库存数量/金额、期间出库、日均出库、周转天数等数值均未取到；②「超周转」周转天数阈值未在导图定义；③财务月报内容因登录墙不可匿名读取。<br>
    <b>产出</b>：本执行单 + 配套《渠道库存周转监控表》Excel 模板（数值列留空，待回填）。<br>
    <b>台账</b>：上次运行 2026-09-14 02:24 结果为「待补数」，本次同因数据源登录墙维持「未完成 / 待补数」。
  </div>
</div>
</body>
</html>
"""

html_path = os.path.join(OUT, f"D_库存周转_执行单_{TS}.html")
with open(html_path, "w", encoding="utf-8") as f:
    f.write(HTML)

# ---------------- Excel ----------------
wb = Workbook()
thin = Side(style="thin", color="D9E1F2")
border = Border(left=thin, right=thin, top=thin, bottom=thin)
hfill = PatternFill("solid", fgColor="3B5BDB")
hfont = Font(color="FFFFFF", bold=True, size=11)
subfill = PatternFill("solid", fgColor="EEF2FF")

def style_header(ws, row, ncols):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = hfill; cell.font = hfont
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = border

# Sheet1 监控表
ws = wb.active
ws.title = "渠道周转监控表"
title = "渠道库存周转监控表（D：库存周转 · room-xgoibqb8 · 生成 " + STAMP + "）"
ws.append([title]); ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=15)
ws["A1"].font = Font(bold=True, size=13, color="3B5BDB")
ws["A1"].alignment = Alignment(horizontal="left", vertical="center")
ws.append([])
hdr = ["序号", "渠道组", "渠道", "店铺名称", "店铺编号",
       "期末库存数量", "期末库存金额(元)", "期间出库数量", "期间天数",
       "日均出库", "周转天数", "阈值(天)", "周转状态", "判定动作", "预期周转正常时间"]
ws.append(hdr)
style_header(ws, 3, len(hdr))
for i, (g, c, s, code) in enumerate(CH, 1):
    ws.append([i, g, c, s, code, None, None, None, None, None, None, None, "待判定", None, None])
# 公式辅助列：日均出库 & 周转天数
for i in range(len(CH)):
    r = 4 + i
    ws.cell(row=r, column=10).value = f"=IFERROR(H{r}/I{r},\"\")"          # 日均出库
    ws.cell(row=r, column=11).value = f"=IFERROR(F{r}/J{r},\"\")"          # 周转天数
    for col in range(1, 16):
        cell = ws.cell(row=r, column=col)
        cell.border = border
        cell.alignment = Alignment(vertical="center", wrap_text=(col == 4))
widths = [5, 9, 11, 30, 15, 12, 14, 12, 10, 11, 11, 9, 10, 16, 16]
for idx, w in enumerate(widths, 1):
    ws.column_dimensions[ws.cell(row=3, column=idx).column_letter].width = w
ws.freeze_panes = "A4"

# Sheet2 取数口径
ws2 = wb.create_sheet("取数口径与字段说明")
ws2.append(["字段", "口径 / 说明", "来源", "备注"])
style_header(ws2, 1, 4)
calib = [
    ["期末库存数量", "指定时点各店铺可用库存数量", "ERP 吉客云-分仓库存查询", "按渠道编码归集"],
    ["期末库存金额(元)", "期末库存数量 × 单位成本（财务口径）", "财务-月度库存管理报表", "登录墙，需授权"],
    ["期间出库数量", "统计期内该店铺出库/销售数量", "ERP 吉客云-销售单明细账", "与销售日报表核对"],
    ["期间天数", "统计期自然天数（如月度=30/31）", "计算参数", "口径需与财务一致"],
    ["日均出库", "期间出库数量 ÷ 期间天数（表内公式）", "计算列", "自动计算"],
    ["周转天数", "期末库存数量 ÷ 日均出库（表内公式）", "计算列", "自动计算"],
    ["阈值(天)", "判定「超周转」的周转天数上限", "业务确认（导图未定义）", "缺口：待补充"],
    ["周转状态", "周转天数>阈值→超周转；≤阈值→周转正常", "判定", "阈值缺失时留「待判定」"],
    ["判定动作", "超周转→销售提升计划；正常→保持销售", "SOP 定义", "—"],
]
for r in calib:
    ws2.append(r)
for row in ws2.iter_rows(min_row=2, max_row=ws2.max_row, max_col=4):
    for cell in row:
        cell.border = border; cell.alignment = Alignment(vertical="center", wrap_text=True)
for idx, w in enumerate([16, 40, 28, 20], 1):
    ws2.column_dimensions[ws2.cell(row=1, column=idx).column_letter].width = w
ws2.freeze_panes = "A2"

# Sheet3 SOP 步骤检查
ws3 = wb.create_sheet("SOP步骤检查项")
ws3.append(["#", "动作", "说明", "责任人/系统", "频率", "状态"])
style_header(ws3, 1, 6)
for n, a, d, who, fq, st in STEPS:
    ws3.append([int(n), html.unescape(a), d, who, fq, st])
for row in ws3.iter_rows(min_row=2, max_row=ws3.max_row, max_col=6):
    for cell in row:
        cell.border = border; cell.alignment = Alignment(vertical="center", wrap_text=True)
for idx, w in enumerate([5, 30, 34, 16, 8, 14], 1):
    ws3.column_dimensions[ws3.cell(row=1, column=idx).column_letter].width = w
ws3.freeze_panes = "A2"

xlsx_path = os.path.join(OUT, f"D_库存周转_监控表_{TS}.xlsx")
wb.save(xlsx_path)

print("HTML:", html_path, os.path.getsize(html_path))
print("XLSX:", xlsx_path, os.path.getsize(xlsx_path))
