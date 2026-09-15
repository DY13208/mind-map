# -*- coding: utf-8 -*-
"""生成 D：历史GMV数据汇总分析 的产物：Excel 工作簿 + 单页 HTML 执行单。"""
import os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

OUT = r"d:\liangce\mind-map\output"
STAMP = "2026-09-14_1108"
STEM = "D_历史GMV数据汇总分析"
XLSX = os.path.join(OUT, f"{STEM}_{STAMP}.xlsx")
HTML = os.path.join(OUT, f"{STEM}_{STAMP}.html")

# ---- 渠道口径登记表（100% 来自导图「渠道定义和统计维度」+「渠道定位和目标设定逻辑」，非编造）----
# 序号, 一级部门, 二级渠道, 三级店铺, 渠道编码, 渠道类型, 定位档位, 增长要求, 是否豁免
REG = [
    (1,  "个护部", "天猫",     "个护部天猫UNOVE柔诺伊官方旗舰店",     "13CHAN10030",   "B2C", "核心直营", "高增长",               "否"),
    (2,  "个护部", "天猫国际", "个护部天猫UNOVE海外旗舰店",           "13CHAN10039",   "B2C", "核心直营", "高增长",               "否"),
    (3,  "直播组", "抖音",     "直播组抖音UNOVE柔诺伊官方旗舰店",     "13CHAN10132",   "B2C", "核心直营", "高增长",               "否"),
    (4,  "直播组", "抖音",     "直播组抖音UNOVE柔诺伊个人护理旗舰店", "13CHAN10029",   "B2C", "核心直营", "高增长",               "否"),
    (5,  "直播组", "快手",     "直播组快手UNOVE柔诺伊旗舰店",         "13CHAN10033",   "B2C", "核心直营", "高增长",               "否"),
    (6,  "直播组", "小红书",   "直播组小红书UNOVE柔诺伊旗舰店",       "13CHAN10041",   "B2C", "核心直营", "豁免（保持在售即可）",  "是"),
    (7,  "直供组", "天猫超市", "直供组天猫超市供货-UNOVE",             "13CHAN40025-04","B2C", "正常直营", "按比例增长（低于核心）","否"),
    (8,  "直供组", "京东",     "直供组商务UNOVE京东自营旗舰店",       "13CHAN10100",   "B2C", "正常直营", "按比例增长（低于核心）","否"),
    (9,  "直供组", "京东",     "赛燃UNOVE海外京东自营旗舰店",         "SAIRAN0021",    "B2C", "正常直营", "按比例增长（低于核心）","否"),
    (10, "直供组", "得物",     "得物大贸UNOVE",                        "XXJ019",        "B2C", "正常直营", "按比例增长（低于核心）","否"),
    (11, "零售组", "拼多多",   "零售组拼多多UNOVE柔诺伊美容护发旗舰店","13CHAN10048",   "B2C", "正常直营", "按比例增长（低于核心）","否"),
    (12, "面护部", "唯品会",   "面护部唯品会大贸-UNOVE",               "13CHAN10122",   "B2C", "观察期直营","豁免（保持在售即可）",  "是"),
    (13, "外贸组", "—",        "外贸组UNOVE分销",                     "XXJ003",        "B2B", "核心分销", "高增长",               "否"),
    (14, "分销组", "—",        "分销组UNOVE",                          "13CHAN10058",   "B2B", "核心分销", "高增长",               "否"),
    (15, "线下组", "—",        "线下组UNOVE",                          "13CHAN10084",   "B2B", "核心分销", "高增长",               "否"),
    (16, "直供组", "—",        "直供组UNOVE分销-回款",                 "XXJ025",        "B2B", "正常分销", "按比例增长",           "否"),
    (17, "KA组",   "—",        "KA组UNOVE分销",                        "13CHAN50135",   "B2B", "正常分销", "按比例增长",           "否"),
]

# ---------- 样式 ----------
HDR_FILL = PatternFill("solid", fgColor="1D3A8F")
HDR_FONT = Font(color="FFFFFF", bold=True, size=11)
TITLE_FONT = Font(color="1D3A8F", bold=True, size=13)
WRAP = Alignment(wrap_text=True, vertical="top")
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
THIN = Side(style="thin", color="D6DCE6")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WARN_FILL = PatternFill("solid", fgColor="FFF7E8")
LINK_FONT = Font(color="2F6BFF", underline="single")


def style_header(ws, row=1, ncol=1):
    for c in range(1, ncol + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = HDR_FILL; cell.font = HDR_FONT
        cell.alignment = CENTER; cell.border = BORDER


def set_widths(ws, widths):
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w


wb = Workbook()

# ===== Sheet 1 说明与缺口 =====
ws = wb.active; ws.title = "说明与数据缺口"
rows = [
    ("D：历史GMV数据汇总分析 — 交付说明", None),
    ("SOP 节点", "D：历史GMV数据汇总分析"),
    ("节点 uid", "a591bb32-4095-4a6d-aa41-277853a89a1f"),
    ("归属路径", "C：UN项目利润分 → P：品牌目标 → P：制定GMV目标 → D：历史GMV数据汇总分析"),
    ("房间", "room-xgoibqb8（UN项目工程）· owner 陈华俊Alex"),
    ("生成时间", "2026-09-14 11:08"),
    ("执行状态", "未完成 — 渠道口径/流程可复用，真实 GMV 数值缺失（数据源为登录墙）"),
    ("", ""),
    ("【可引用真实口径 · 来自导图】", None),
    ("渠道分组（一级单位）", "10 个分支节点，去重 9 个部门（直供组出现两次）"),
    ("渠道编码（三级店铺）", "17 个"),
    ("渠道定位档位", "6 档：核心直营 / 正常直营 / 观察期直营 / 核心分销 / 正常分销（+小红书豁免）"),
    ("销售日报表数据源", "企业微信 smartsheet（导图已挂外链）"),
    ("2026年渠道目标数据源", "企业微信 sheet（导图已挂外链）"),
    ("", ""),
    ("【关键缺口 · 需人工取数/授权】", None),
    ("缺口1", "两个企业微信数据表均为登录墙：HTTP 200 但正文 0 字节，匿名/无授权无法读取任何 GMV 数值。"),
    ("缺口2", "导图内不存在任何历史 GMV 数值、目标值或完成率数据，仅流程与口径。"),
    ("缺口3", "「B2B的GMV维度销售数据登记表」在导图中未挂外链，无法定位。"),
    ("缺口4", "渠道增长比例需按品牌要求人工分配，比例值未在导图内给出。"),
    ("取数方式", "请在已登录企业微信的浏览器打开两张表，导出为 xlsx/csv 后回贴；或在导图节点补充数值。"),
]
ws.column_dimensions["A"].width = 26
ws.column_dimensions["B"].width = 96
r = 1
for k, v in rows:
    a = ws.cell(row=r, column=1, value=k)
    b = ws.cell(row=r, column=2, value=v)
    if k.startswith("D：") and v is None:
        a.font = Font(bold=True, size=14, color="1D3A8F")
    elif k.startswith("【"):
        a.font = Font(bold=True, color="8A5A00"); a.fill = WARN_FILL; b.fill = WARN_FILL
    elif k:
        a.font = Font(bold=True)
    for c in (a, b):
        c.alignment = WRAP; c.border = BORDER
    r += 1

# ===== Sheet 2 渠道口径登记表 =====
ws2 = wb.create_sheet("渠道口径登记表")
hdr2 = ["序号", "一级部门", "二级渠道", "三级店铺", "渠道编码", "渠道类型", "定位档位", "增长要求", "是否豁免"]
ws2.append(hdr2)
for row in REG:
    ws2.append(list(row))
style_header(ws2, 1, len(hdr2))
set_widths(ws2, [6, 10, 10, 34, 15, 10, 12, 22, 10])
for rr in range(2, ws2.max_row + 1):
    for cc in range(1, len(hdr2) + 1):
        cell = ws2.cell(row=rr, column=cc)
        cell.border = BORDER
        cell.alignment = CENTER if cc in (1, 2, 3, 5, 6, 7, 9) else WRAP
ws2.freeze_panes = "A2"

# ===== Sheet 3 销售日报表取数模板 =====
ws3 = wb.create_sheet("销售日报表取数模板")
hdr3 = ["统计日期", "一级部门", "二级渠道", "三级店铺", "渠道编码", "GMV(元)", "实收(元)", "订单量", "数据来源", "更新人", "备注"]
ws3.append(hdr3)
ws3.append(["2026-09-14", "个护部", "天猫", "个护部天猫UNOVE柔诺伊官方旗舰店", "13CHAN10030", "", "", "", "企业微信-销售日报表", "", "【示例行：填数后删除】"])
for _ in range(20):
    ws3.append([])
style_header(ws3, 1, len(hdr3))
set_widths(ws3, [12, 10, 10, 34, 15, 12, 12, 9, 18, 10, 22])
for rr in range(2, ws3.max_row + 1):
    for cc in range(1, len(hdr3) + 1):
        ws3.cell(row=rr, column=cc).border = BORDER
for cc in range(1, len(hdr3) + 1):
    ws3.cell(row=2, column=cc).fill = WARN_FILL
ws3.freeze_panes = "A2"

# ===== Sheet 4 2026年渠道目标取数模板 =====
ws4 = wb.create_sheet("2026年渠道目标取数模板")
hdr4 = ["序号", "一级部门", "二级渠道", "三级店铺", "渠道编码", "定位档位",
        "Q1目标", "Q2目标", "Q3目标", "Q4目标", "年度目标(锁定)", "累计GMV(实)", "目标完成率"]
ws4.append(hdr4)
for row in REG:
    ws4.append([row[0], row[1], row[2], row[3], row[4], row[6],
                "", "", "", "", "", "", None])
style_header(ws4, 1, len(hdr4))
set_widths(ws4, [6, 10, 10, 30, 15, 12, 11, 11, 11, 11, 15, 14, 12])
n = ws4.max_row
for rr in range(2, n + 1):
    for cc in range(1, len(hdr4) + 1):
        cell = ws4.cell(row=rr, column=cc)
        cell.border = BORDER
        cell.alignment = CENTER if cc in (1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13) else WRAP
    # 完成率 = 累计GMV / 年度目标
    ws4.cell(row=rr, column=13).value = f'=IFERROR(L{rr}/K{rr},"")'
    ws4.cell(row=rr, column=13).number_format = "0.0%"
    ws4.cell(row=rr, column=11).fill = PatternFill("solid", fgColor="EEF1F7")
ws4.freeze_panes = "A2"
for rr in range(2, n + 1):
    pass

# ===== Sheet 5 GMV汇总分析口径 =====
ws5 = wb.create_sheet("GMV汇总分析口径")
hdr5 = ["序号", "统计步骤 / 指标", "口径与公式", "数据来源", "节奏"]
ws5.append(hdr5)
data5 = [
    (1, "渠道唯一识别", "以「渠道编码 + 渠道名称」唯一性识别 UNOVE 全渠道销售额；部门/店铺名改动时以渠道编码为准",
     "导图节点「渠道定义和统计维度」备注", "常态"),
    (2, "三级归纳结构", "一级=部门，二级=渠道，三级=具体店铺，共 17 个店铺渠道编码", "同一备注", "常态"),
    (3, "销售日报表更新", "全渠道以日维度更新 GMV/实收；渠道定位沿用「渠道定义和渠道定位」", "企业微信 smartsheet（日更）", "每天"),
    (4, "2026年渠道目标更新", "每季度第一天更新；全年总目标确定后不可修改，每季度复盘一次季度目标", "企业微信 sheet", "每季首日"),
    (5, "渠道GMV销售进度", "= 统计期内渠道累计 GMV", "B2B的GMV维度销售数据登记表 / 销售日报表", "日/季"),
    (6, "目标完成率", "= 累计GMV ÷ 年度（或季度）目标 GMV", "2026年渠道目标 + 销售日报表", "日/季"),
    (7, "增长要求分级", "核心直营/核心分销=按比例高增长；正常直营/正常分销=按比例增长（低于核心）；观察期直营+小红书=豁免（保持在售）",
     "导图「渠道增长」「渠道豁免」备注", "年度"),
]
for d in data5:
    ws5.append(list(d))
style_header(ws5, 1, len(hdr5))
set_widths(ws5, [6, 20, 62, 34, 10])
for rr in range(2, ws5.max_row + 1):
    for cc in range(1, len(hdr5) + 1):
        cell = ws5.cell(row=rr, column=cc)
        cell.border = BORDER
        cell.alignment = CENTER if cc in (1, 5) else WRAP
ws5.freeze_panes = "A2"

os.makedirs(OUT, exist_ok=True)
wb.save(XLSX)
print("XLSX ->", XLSX, os.path.getsize(XLSX), "bytes")

# ---------------- HTML ----------------
esc = lambda s: (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

reg_rows = "\n".join(
    f"      <tr><td>{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td>"
    f"<td><code>{r[4]}</code></td><td>{r[5]}</td>"
    f"<td><span class='pill {'info' if '核心' in r[6] else ('wait' if '观察' in r[6] else 'ok')}'>{r[6]}</span></td>"
    f"<td>{'<span class=\"muted\">豁免</span>' if r[8]=='是' else r[7]}</td></tr>"
    for r in REG
)

LINK_SALES = "https://doc.weixin.qq.com/smartsheet/s3_AMwAoQZzAMECNeNTdk449SHW301Jo?scode=ALwAJwfTAAgd4JAMaWAMwAoQZzAME&tab=taDIvD&viewId=vO3teT"
LINK_TARGET = "https://doc.weixin.qq.com/sheet/e3_AbUAJQbFAEECNv1FFKAuoTra7QEAT?scode=ALwAJwfTAAgJkia7KyAbUAJQbFAEE&tab=BB08J2"

html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>D：历史GMV数据汇总分析 · 执行单 2026-09-14</title>
<style>
  :root{{
    --ink:#1f2733; --sub:#6b7686; --line:#e5e9f0;
    --bg:#f4f6fa; --card:#ffffff;
    --brand:#1d3a8f; --brand2:#2f6bff;
    --warn-bg:#fff7e8; --warn-bd:#f2c66d; --warn-tx:#8a5a00;
    --red:#d64545; --green:#1e9e6a; --amber:#c98a12; --blue:#2f6bff;
  }}
  *{{box-sizing:border-box;margin:0;padding:0}}
  body{{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Helvetica Neue",Arial,sans-serif;line-height:1.55;padding:28px 16px}}
  .page{{max-width:1040px;margin:0 auto}}
  .head{{background:linear-gradient(135deg,var(--brand) 0%,var(--brand2) 100%);border-radius:16px;padding:22px 26px;color:#fff;box-shadow:0 8px 24px rgba(29,58,143,.18)}}
  .head .tags{{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}}
  .tag{{background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.35);padding:2px 10px;border-radius:999px;font-size:12px}}
  .head h1{{font-size:24px;font-weight:700;letter-spacing:.5px}}
  .head .sub{{margin-top:6px;font-size:13px;opacity:.92;display:flex;flex-wrap:wrap;gap:4px 16px}}
  .alert{{margin-top:16px;background:var(--warn-bg);border:1px solid var(--warn-bd);border-left:5px solid var(--amber);border-radius:10px;padding:14px 16px;font-size:14px;color:var(--warn-tx)}}
  .alert b{{color:#6b4a00}}
  section{{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-top:16px;box-shadow:0 2px 6px rgba(20,30,60,.04)}}
  .sec-title{{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700;margin-bottom:14px}}
  .sec-title .no{{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:var(--brand);color:#fff;font-size:13px;flex:none}}
  .kpis{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}}
  .kpi{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 14px 12px;border-top:3px solid var(--brand2)}}
  .kpi .k{{font-size:12px;color:var(--sub)}}
  .kpi .v{{font-size:20px;font-weight:700;margin-top:4px;letter-spacing:.3px}}
  .kpi .s{{font-size:11px;color:var(--sub);margin-top:4px}}
  .v.pending{{color:var(--amber)}} .v.calc{{color:var(--brand)}} .v.na{{color:var(--red)}} .v.ok{{color:var(--green)}}
  .tbl{{width:100%;border-collapse:collapse;font-size:13px}}
  .tbl th{{background:#eef1f7;color:#39414f;text-align:left;padding:9px 10px;font-weight:600;border:1px solid var(--line);white-space:nowrap}}
  .tbl td{{padding:9px 10px;border:1px solid var(--line);vertical-align:top}}
  .tbl tr:nth-child(even) td{{background:#fafbfd}}
  .pill{{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}}
  .pill.ok{{background:#e6f6ef;color:var(--green)}}
  .pill.wait{{background:#fff4de;color:var(--amber)}}
  .pill.info{{background:#e9efff;color:var(--brand2)}}
  .pill.red{{background:#fdeaea;color:var(--red)}}
  ol.acts{{list-style:none;counter-reset:act}}
  ol.acts li{{counter-increment:act;position:relative;padding:10px 12px 10px 46px;border:1px solid var(--line);border-radius:10px;margin-bottom:10px;background:#fcfdff}}
  ol.acts li::before{{content:counter(act);position:absolute;left:12px;top:11px;width:24px;height:24px;border-radius:50%;background:var(--brand);color:#fff;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center}}
  ol.acts b{{color:var(--brand)}}
  .who{{color:var(--brand2);font-weight:600}}
  code{{background:#e2e7f1;padding:0 4px;border-radius:4px;font-size:12px}}
  .foot{{margin-top:16px;font-size:12px;color:var(--sub);background:#eef1f7;border-radius:10px;padding:12px 16px;line-height:1.75}}
  a{{color:var(--blue);text-decoration:none;word-break:break-all}}
  a:hover{{text-decoration:underline}}
  .muted{{color:var(--sub)}}
  .scroll{{overflow-x:auto}}
  @media (max-width:760px){{.kpis{{grid-template-columns:repeat(2,1fr)}}}}
</style>
</head>
<body>
<div class="page">

  <div class="head">
    <div class="tags">
      <span class="tag">良策 SOP · 执行单</span>
      <span class="tag">D：历史GMV数据汇总分析</span>
      <span class="tag">房间 room-xgoibqb8</span>
      <span class="tag">P：制定GMV目标</span>
    </div>
    <h1>D：历史GMV数据汇总分析 — 执行单（UN项目 · 品牌目标 / 制定GMV目标）</h1>
    <div class="sub">
      <span>归属：C：UN项目利润分 → P：品牌目标 → P：制定GMV目标 → D：历史GMV数据汇总分析</span>
      <span>房间 owner：陈华俊Alex</span>
      <span>生成时间：2026-09-14 11:08</span>
    </div>
  </div>

  <div class="alert">
    <b>⚠️ 执行状态：未完成（真实 GMV 数值缺失）</b> —— D 分支给出完整可复用口径
    「每天更新 <b>销售日报表</b>（全渠道日维度）→ 每季首日更新 <b>2026年渠道目标</b> → 按渠道定义与定位汇总 GMV 进度与目标完成率」，
    渠道维度（9 部门 / 17 店铺编码 / 6 档定位）已从导图完整提取；
    但<b>两张数据表均为企业微信登录墙（HTTP 200、正文 0 字节），导图内也无任何历史 GMV 数值</b>，
    故本次交付为「口径 + 取数模板 + 缺口清单」，<b>不伪造任何 GMV 数字</b>。
  </div>

  <section>
    <div class="sec-title"><span class="no">1</span>执行概览（KPI）</div>
    <div class="kpis">
      <div class="kpi"><div class="k">渠道分组（一级单位）</div><div class="v calc">10<span style="font-size:13px;color:#6b7686"> 分支 / 去重9</span></div><div class="s">部门维度，直供组出现两次</div></div>
      <div class="kpi"><div class="k">店铺渠道编码</div><div class="v calc">17</div><div class="s">三级店铺唯一识别</div></div>
      <div class="kpi"><div class="k">关联数据表</div><div class="v pending">2</div><div class="s">销售日报表 + 2026年渠道目标</div></div>
      <div class="kpi"><div class="k">可取真实 GMV 值</div><div class="v na">0</div><div class="s">数据源登录墙，待授权/回贴</div></div>
    </div>
  </section>

  <section>
    <div class="sec-title"><span class="no">2</span>SOP 步骤与检查项</div>
    <div class="scroll"><table class="tbl">
      <thead><tr><th>#</th><th>SOP 步骤</th><th>检查项（C）</th><th>数据源</th><th>节奏</th><th>状态</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>更新表格：<b>销售日报表</b>（全渠道以日维度更新销售数据；渠道定位应用「渠道定义和渠道定位」）</td><td>每日全渠道 GMV/实收已按 17 个渠道编码登记</td><td><a href="{LINK_SALES}" target="_blank">企业微信 smartsheet</a></td><td>每天</td><td><span class="pill red">未取数</span></td></tr>
        <tr><td>2</td><td>更新表格：<b>2026年渠道目标</b>（应用于全渠道 GMV 目标与实收目标）</td><td>年度总目标锁定不可改；每季首日复盘季度目标</td><td><a href="{LINK_TARGET}" target="_blank">企业微信 sheet</a></td><td>每季首日</td><td><span class="pill red">未取数</span></td></tr>
        <tr><td>3</td><td>按渠道定义/定位汇总：得出<b>渠道GMV销售进度</b>与<b>目标完成率</b></td><td>进度=累计GMV；完成率=累计GMV÷目标GMV</td><td>B2B GMV登记表 / 销售日报表 + 渠道目标</td><td>日/季</td><td><span class="pill wait">待上游取数</span></td></tr>
        <tr><td>4</td><td>按渠道增长要求分级校验目标合理性</td><td>核心=高增长；正常=按比例；观察期/小红书=豁免</td><td>导图「渠道增长」「渠道豁免」</td><td>年度</td><td><span class="pill ok">口径已就绪</span></td></tr>
      </tbody>
    </table></div>
  </section>

  <section>
    <div class="sec-title"><span class="no">3</span>渠道口径登记表（真实口径 · 来自导图，共 17 个渠道编码）</div>
    <div class="scroll"><table class="tbl">
      <thead><tr><th>#</th><th>一级部门</th><th>二级渠道</th><th>三级店铺</th><th>渠道编码</th><th>类型</th><th>定位档位</th><th>增长要求</th></tr></thead>
      <tbody>
{reg_rows}
      </tbody>
    </table></div>
    <p class="muted" style="font-size:12px;margin-top:8px">识别规则：以「渠道编码 + 渠道名称」唯一性识别 UNOVE 全渠道销售额；部门/店铺名变更时以渠道编码为准（导图备注）。</p>
  </section>

  <section>
    <div class="sec-title"><span class="no">4</span>判定口径（汇总分析规则）</div>
    <div class="scroll"><table class="tbl">
      <thead><tr><th>指标</th><th>口径 / 公式</th><th>来源</th><th>节奏</th></tr></thead>
      <tbody>
        <tr><td>渠道GMV销售进度</td><td>统计期内该渠道累计 GMV（按渠道编码归集）</td><td>B2B GMV维度销售数据登记表 / 销售日报表</td><td>日 / 季</td></tr>
        <tr><td>目标完成率</td><td>= 累计GMV ÷ 年度（或季度）目标 GMV</td><td>2026年渠道目标 + 销售日报表</td><td>日 / 季</td></tr>
        <tr><td>目标锁定规则</td><td>全年总目标确定后不可修改，每季度可复盘一次季度目标</td><td>导图节点备注</td><td>年度 / 季</td></tr>
        <tr><td>增长分级</td><td>核心直营·核心分销=按比例高增长；正常直营·正常分销=按比例增长（低于核心）；观察期直营 + 小红书=豁免</td><td>导图「渠道增长」「渠道豁免」</td><td>年度</td></tr>
      </tbody>
    </table></div>
  </section>

  <section>
    <div class="sec-title"><span class="no">5</span>本周动作</div>
    <ol class="acts">
      <li><b>取数（阻塞项）</b>：在<b>已登录企业微信</b>的浏览器打开 <a href="{LINK_SALES}" target="_blank">销售日报表</a> 与 <a href="{LINK_TARGET}" target="_blank">2026年渠道目标</a>，导出 xlsx/csv 回贴本会话（或授权读取），据以回填模板并计算完成率。责任人：<span class="who">陈华俊 / 渠道责任人</span>。</li>
      <li><b>回填线下模板</b>：用本单配套 Excel（渠道口径登记表 + 销售日报表取数模板 + 2026年渠道目标取数模板）承接导出的历史 GMV，核对 17 个渠道编码是否齐全。</li>
      <li><b>补齐缺失外链</b>：「B2B的GMV维度销售数据登记表」在导图中未挂链接，请补充，否则 B2B 口径渠道（外贸/分销/线下/直供回款/KA）无取数入口。</li>
      <li><b>确认增长比例</b>：渠道增长比例需按品牌要求人工分配（导图未给值），请确定核心/正常渠道的增长比例，用于 2026 年目标编制。</li>
      <li><b>落地日更机制</b>：确认销售日报表的日更责任人，按「渠道编码」维度每日回填，季度首日复盘并锁定季度目标。</li>
    </ol>
  </section>

  <div class="foot">
    <b>数据来源</b>：思维导图 MCP（room-xgoibqb8，version 256）节点 uid <code>a591bb32-4095-4a6d-aa41-277853a89a1f</code> 及其子树 102 个节点；渠道口径来自「渠道定义和统计维度」「渠道定位和目标设定逻辑」备注。
    <br><b>缺口说明</b>：销售日报表（企业微信 smartsheet）、2026年渠道目标（企业微信 sheet）均为登录墙（HTTP 200 / 正文 0 字节）；导图内无任何 GMV 数值。本单不含任何虚构数字，数值待授权取数后回填。
    <br><b>配套文件</b>：{STEM}_{STAMP}.xlsx（渠道口径 / 取数模板 / 分析口径）。
    <br>生成：WorkBuddy · 2026-09-14 11:08 · 本单只服务「D：历史GMV数据汇总分析」。
  </div>

</div>
</body>
</html>
"""
with open(HTML, "w", encoding="utf-8") as f:
    f.write(html)
print("HTML ->", HTML, os.path.getsize(HTML), "bytes")
