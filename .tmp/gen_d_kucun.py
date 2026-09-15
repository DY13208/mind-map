#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import csv, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "output")
os.makedirs(OUT, exist_ok=True)
STAMP = "2026-09-14_1023"
HTML = os.path.join(OUT, f"D_库存周转_执行单_{STAMP}.html")
CSV = os.path.join(OUT, f"D_库存周转_监控表模板_{STAMP}.csv")

# 监控范围（来源：导图「渠道定义和统计维度」cbd9f127 子树）
channels = [
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

# ---- CSV 监控表模板（空表 + 口径，不填充任何虚构数值）----
with open(CSV, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f)
    w.writerow(["# D：库存周转 - 渠道库存周转监控表（模板，待 ERP 吉客云 / 财务月报 授权后回填）"])
    w.writerow(["# 数据源: ERP 吉客云 销售单明细账 & 分仓库存查询 | 财务 月度库存管理报表(drive.weixin.qq.com 登录墙)"])
    w.writerow(["# 生成时间: 2026-09-14 10:23 | 房间: room-xgoibqb8 | 责任人: 陈华俊 | 硬约束: 数值待取数，禁止虚构"])
    w.writerow([])
    w.writerow([
        "渠道组", "渠道", "店铺名称", "店铺编号",
        "期末库存数量", "期末库存金额(元)", "本期出库数量(30天)", "日均出库数量",
        "周转天数(天)", "周转状态(超周转/周转正常/待判定)",
        "预期周转正常时间", "渠道销售提升计划/保持销售", "数据来源", "备注",
    ])
    for grp, ch, name, code in channels:
        w.writerow([grp, ch, name, code, "", "", "", "", "", "待判定", "", "", "ERP吉客云/财务月报(待授权)", ""])

# ---- HTML 执行单 ----
kpi = [
    ("监控渠道门店", "17", "10 个渠道组 / 17 个店铺编号", "b-blue"),
    ("数据源接入", "0 / 2", "ERP 吉客云、财务月度报表 均未授权取数", "b-red"),
    ("超周转渠道", "待取数", "需库存周转天数与阈值口径", "b-amber"),
    ("周转正常渠道", "待取数", "判定后标注「保持销售」动作", "b-green"),
]

steps = [
    ("1", "渠道库存周转监控（责任：陈华俊）", "对全部 17 个渠道门店盘点库存与周转情况", "陈华俊", "周期制", "待执行"),
    ("2", "ERP 取数：吉客云销售单明细账 &amp; 分仓库存查询", "按渠道/店铺拉取库存量与出库流水，作为周转计算底表", "ERP 系统 / 陈华俊", "取数", "阻塞：登录授权"),
    ("3", "WORKBUDDY：生成库存周转报告", "汇总各渠道周转天数，自动分档并出报告", "WorkBuddy", "按次", "待喂数"),
    ("4", "库存周转进度 · 判定", "分「超周转」与「周转正常」两类", "陈华俊", "按次", "待判定"),
    ("5", "超周转 → 预期周转正常时间", "对超周转渠道测算清库/转正常时点", "陈华俊", "按次", "待判定"),
    ("6", "超周转 → 渠道销售提升计划", "对超周转渠道给出促销/渠道分销消化动作", "陈华俊", "按次", "待判定"),
    ("7", "周转正常 → 保持销售", "周转正常渠道维持当前销售节奏", "陈华俊", "持续", "待判定"),
    ("8", "财务：月度库存管理报表", "财务侧月度库存报表，与渠道侧口径对齐", "财务", "月度", "阻塞：登录墙"),
]

criteria = [
    ("超周转", "周转天数高于约定阈值（阈值口径缺失，需企微文档/ERP 补充）", "测算「预期周转正常时间」并制定「渠道销售提升计划」", "ERP 吉客云 + 财务月报"),
    ("周转正常", "周转天数在约定阈值内", "执行「保持销售」，维持节奏", "ERP 吉客云 + 财务月报"),
    ("待判定", "数据未取到 / 阈值未确认", "先取数、再确认阈值，暂不判档", "—（当前状态）"),
]

actions = [
    "【取数】开通/登录 ERP 吉客云，导出「销售单明细账」与「分仓库存查询」，覆盖上述 17 个渠道门店。",
    "【对标】在财务「月度库存管理报表」（企业微信微盘，需登录）中确认各渠道库存金额与周转天数口径。",
    "【定阈值】确认「超周转」的周转天数阈值（当前导图无阈值定义，需业务补充），否则无法自动判档。",
    "【报表】上游数据到位后，用 WorkBuddy 生成「库存周转报告」，输出超周转/周转正常分档清单。",
    "【动作】对超周转渠道逐个给出「预期周转正常时间」+「渠道销售提升计划」；周转正常渠道标注「保持销售」。",
    "【对齐】渠道侧监控结果与财务月度报表做一致性核对，避免口径差异。",
]

def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

kpi_html = "\n".join(
    f'<div class="kpi {c}"><div class="kpi-v">{esc(v)}</div><div class="kpi-l">{esc(l)}</div><div class="kpi-s">{esc(s)}</div></div>'
    for l, v, s, c in kpi)

steps_html = "\n".join(
    f'<tr><td class="c">{n}</td><td>{t}</td><td>{d}</td><td>{r}</td><td class="c">{f}</td>'
    f'<td class="c st">{st}</td></tr>'
    for n, t, d, r, f, st in steps)

crit_html = "\n".join(
    f'<tr><td><span class="tag">{esc(a)}</span></td><td>{esc(b)}</td><td>{esc(cc)}</td><td class="muted">{esc(dd)}</td></tr>'
    for a, b, cc, dd in criteria)

chan_html = "\n".join(
    f'<tr><td>{esc(g)}</td><td>{esc(c)}</td><td>{esc(n)}</td><td class="mono">{esc(code)}</td>'
    f'<td class="c muted">待判定</td></tr>'
    for g, c, n, code in channels)

act_html = "\n".join(f"<li>{esc(a)}</li>" for a in actions)

html = f"""<!DOCTYPE html>
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
    <div class="sub">渠道库存周转监控 → ERP 取数 → WorkBuddy 生成库存周转报告 → 财务月度库存管理报表</div>
    <div class="meta">
      <span class="chip">房间 room-xgoibqb8 · UN项目工程 (v254)</span>
      <span class="chip">分支 P：购销存循环</span>
      <span class="chip">责任人 陈华俊</span>
      <span class="chip">节点 uid efb26842…afd5</span>
      <span class="chip">生成 2026-09-14 10:23</span>
    </div>
  </div>

  <div class="alert">
    <b>⚠ 关键数据缺口（未完成判定）</b>：本 SOP 的两个数据源均为登录墙——① <b>ERP 吉客云</b>（销售单明细账 &amp; 分仓库存查询）需账号授权登录；
    ② <b>财务月度库存管理报表</b>为<b>企业微信微盘链接</b>（https://drive.weixin.qq.com/s?k=ALwAJwfTAAgOKrqv9m），匿名访问仅返回登录壳页（标题「库存管理报表2026年」），无表格数据。
    导图内亦无库存数值、无「超周转」周转天数阈值定义。因此本次<b>不填任何库存数值、不伪造数字</b>，按真实流程与口径出具执行单，待取数后回填。
  </div>

  <div class="kpis">
    {kpi_html}
  </div>

  <div class="sec">
    <h2>SOP 步骤与检查项</h2>
    <table>
      <tr><th class="c" style="width:44px">#</th><th>动作</th><th>说明</th><th style="width:120px">责任人/系统</th><th class="c" style="width:70px">频率</th><th class="c" style="width:110px">状态</th></tr>
      {steps_html}
    </table>
  </div>

  <div class="sec">
    <h2>判定口径（周转进度分档）</h2>
    <table>
      <tr><th style="width:110px">状态</th><th>触发条件</th><th>对应动作</th><th style="width:190px">数据来源</th></tr>
      {crit_html}
    </table>
  </div>

  <div class="sec">
    <h2>监控范围（渠道 / 店铺）· 共 17 个店铺编号</h2>
    <table>
      <tr><th style="width:110px">渠道组</th><th style="width:120px">渠道</th><th>店铺名称</th><th style="width:150px">店铺编号</th><th class="c" style="width:90px">周转状态</th></tr>
      {chan_html}
    </table>
  </div>

  <div class="sec">
    <h2>本周动作（取数 → 判档 → 动作）</h2>
    <ol class="act">
      {act_html}
    </ol>
  </div>

  <div class="foot">
    <b>数据来源</b>：mind-map MCP（room-xgoibqb8 v254，updated_at 2026-09-14T01:49Z）读取「D：库存周转」efb26842 子树、「渠道定义和统计维度」cbd9f127 子树。<br>
    <b>外部数据源</b>：ERP 吉客云（登录授权）；财务月度库存管理报表 drive.weixin.qq.com（企业微信微盘，登录墙）。<br>
    <b>缺口说明</b>：①库存数量/金额、日均出库、周转天数等数值均未取到；②「超周转」周转天数阈值未在导图定义；③财务月报内容因登录墙不可匿名读取。<br>
    <b>产出</b>：本执行单 + 配套《渠道库存周转监控表》CSV 模板（空表，待回填）。
  </div>
</div>
</body>
</html>
"""

with open(HTML, "w", encoding="utf-8") as f:
    f.write(html)

print("HTML:", os.path.abspath(HTML), os.path.getsize(HTML), "bytes")
print("CSV:", os.path.abspath(CSV), os.path.getsize(CSV), "bytes")
