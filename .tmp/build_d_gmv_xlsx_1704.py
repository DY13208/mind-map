# -*- coding: utf-8 -*-
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

TS = "2026-09-14_1704"
OUT = "d:\\liangce\\mind-map\\output\\D_历史GMV数据汇总分析_%s.xlsx" % TS

wb = openpyxl.Workbook()

HDR_FILL = PatternFill("solid", fgColor="1F4E79")
HDR_FONT = Font(color="FFFFFF", bold=True, size=10)
SUB_FILL = PatternFill("solid", fgColor="DDEBF7")
TODO_FILL = PatternFill("solid", fgColor="FFF2CC")
CORE_FILL = PatternFill("solid", fgColor="E2EFDA")
thin = Side(style="thin", color="BFBFBF")
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)

# ---------------- Sheet 1 ----------------
ws = wb.active
ws.title = "渠道GMV汇总_填报模板"
title = "D：历史GMV数据汇总分析 — 全渠道 GMV/实收 汇总填报模板（数值列待业务/财务回填）"
ws.append([title])
ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=15)
ws["A1"].font = Font(bold=True, size=13, color="1F4E79")
ws["A1"].alignment = Alignment(horizontal="left", vertical="center")
ws.append(["数据源：销售日报表(smartsheet，实收/GMV 双维度) + 2026年渠道目标(sheet) + B2B的GMV维度销售数据登记表；口径见「取数口径与规则」页"])
ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=15)
ws["A2"].font = Font(size=9, color="7F7F7F")
ws.append([])

headers = ["序号", "部门(一级)", "渠道/平台(二级)", "店铺(三级)", "渠道编码(唯一识别)",
           "渠道定位(SOP口径)", "增长要求", "年度GMV目标(元)", "累计GMV(元)", "GMV完成率",
           "年度实收目标(元)", "累计实收(元)", "实收完成率", "目标来源表", "填数状态"]
ws.append(headers)
hr = ws.max_row
for c in range(1, len(headers) + 1):
    cell = ws.cell(row=hr, column=c)
    cell.fill = HDR_FILL
    cell.font = HDR_FONT
    cell.border = BORDER
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

rows = [
    ("个护部", "天猫", "个护部天猫UNOVE柔诺伊官方旗舰店", "13CHAN10030", "核心直营渠道", "按比例高增长"),
    ("个护部", "天猫国际", "个护部天猫UNOVE海外旗舰店", "13CHAN10039", "核心直营渠道", "按比例高增长"),
    ("直播组", "抖音", "直播组抖音UNOVE柔诺伊官方旗舰店", "13CHAN10132", "核心直营渠道", "按比例高增长"),
    ("直播组", "抖音", "直播组抖音UNOVE柔诺伊个人护理旗舰店", "13CHAN10029", "核心直营渠道", "按比例高增长"),
    ("直播组", "快手", "直播组快手UNOVE柔诺伊旗舰店", "13CHAN10033", "核心直营渠道", "按比例高增长"),
    ("直播组", "小红书", "直播组小红书UNOVE柔诺伊旗舰店", "13CHAN10041", "核心直营渠道", "豁免：保持在售即可，不要求按比例增长"),
    ("直供组", "天猫超市", "直供组天猫超市供货-UNOVE", "13CHAN40025-04", "正常直营渠道", "按比例增长（低于核心直营）"),
    ("直供组", "京东", "直供组商务UNOVE京东自营旗舰店", "13CHAN10100", "正常直营渠道", "按比例增长（低于核心直营）"),
    ("直供组", "京东", "赛燃UNOVE海外京东自营旗舰店", "SAIRAN0021", "正常直营渠道", "按比例增长（低于核心直营）"),
    ("直供组", "得物", "得物大贸UNOVE", "XXJ019", "正常直营渠道", "按比例增长（低于核心直营）"),
    ("零售组", "拼多多", "零售组拼多多UNOVE柔诺伊美容护发旗舰店", "13CHAN10048", "正常直营渠道", "按比例增长（低于核心直营）"),
    ("面护部", "唯品会", "面护部唯品会大贸-UNOVE", "13CHAN10122", "观察期直营渠道", "豁免：观察期，不强制增长"),
    ("外贸组", "B2B分销", "外贸组UNOVE分销", "XXJ003", "核心分销渠道", "按比例高增长"),
    ("分销组", "B2B分销", "分销组UNOVE", "13CHAN10058", "核心分销渠道", "按比例高增长"),
    ("线下组", "B2B分销", "线下组UNOVE", "13CHAN10084", "核心分销渠道", "按比例高增长"),
    ("直供组", "B2B分销-回款", "直供组UNOVE分销-回款", "XXJ025", "正常分销渠道", "按比例增长（低于核心分销）"),
    ("KA组", "B2B分销", "KA组UNOVE分销", "13CHAN50135", "正常分销渠道", "按比例增长（低于核心分销）"),
]
start = ws.max_row + 1
for i, (dept, plat, shop, code, pos, grow) in enumerate(rows, 1):
    r = start + i - 1
    ws.append([i, dept, plat, shop, code, pos, grow, None, None, None, None, None, None,
               "2026年渠道目标", "待回填"])
    ws.cell(row=r, column=10).value = '=IF(OR(H%d="",H%d=0),"待回填",I%d/H%d)' % (r, r, r, r)
    ws.cell(row=r, column=13).value = '=IF(OR(K%d="",K%d=""),"待回填",L%d/K%d)' % (r, r, r, r)
    for c in range(1, 16):
        cell = ws.cell(row=r, column=c)
        cell.border = BORDER
        cell.font = Font(size=10)
        cell.alignment = Alignment(vertical="center", wrap_text=(c in (3, 7)))
    for c in (8, 9, 10, 11, 12, 13):
        ws.cell(row=r, column=c).fill = TODO_FILL
    ws.cell(row=r, column=5).fill = CORE_FILL
    ws.cell(row=r, column=10).number_format = "0.0%"
    ws.cell(row=r, column=13).number_format = "0.0%"

tot = ws.max_row + 1
ws.cell(row=tot, column=1, value="合计").font = Font(bold=True, size=10)
ws.cell(row=tot, column=8, value="=SUM(H%d:H%d)" % (start, tot - 1))
ws.cell(row=tot, column=9, value="=SUM(I%d:I%d)" % (start, tot - 1))
ws.cell(row=tot, column=10, value='=IF(OR(H%d=0,H%d=""),"待回填",I%d/H%d)' % (tot, tot, tot, tot))
ws.cell(row=tot, column=11, value="=SUM(K%d:K%d)" % (start, tot - 1))
ws.cell(row=tot, column=12, value="=SUM(L%d:L%d)" % (start, tot - 1))
ws.cell(row=tot, column=13, value='=IF(OR(K%d=0,K%d=""),"待回填",L%d/K%d)' % (tot, tot, tot, tot))
for c in range(1, 16):
    ws.cell(row=tot, column=c).fill = SUB_FILL
    ws.cell(row=tot, column=c).border = BORDER
    ws.cell(row=tot, column=c).font = Font(bold=True, size=10)
ws.cell(row=tot, column=10).number_format = "0.0%"
ws.cell(row=tot, column=13).number_format = "0.0%"

widths = [5, 9, 26, 34, 17, 15, 26, 15, 14, 10, 15, 14, 10, 14, 10]
for i, w in enumerate(widths, 1):
    ws.column_dimensions[get_column_letter(i)].width = w
ws.freeze_panes = "A%d" % (hr + 1)
ws.row_dimensions[1].height = 24

# ---------------- Sheet 2 ----------------
ws2 = wb.create_sheet("取数口径与规则")
ws2.append(["项", "内容", "来源节点(uid)"])
for c in (1, 2, 3):
    cell = ws2.cell(row=1, column=c)
    cell.fill = HDR_FILL
    cell.font = HDR_FONT
    cell.border = BORDER
    cell.alignment = Alignment(horizontal="center")
rules = [
    ("SOP 步骤①", "每天，更新表格：销售日报表", "d82d2fc2"),
    ("步骤①要点", "全渠道以日维度更新销售数据", "bff9f9f6"),
    ("步骤①要点", "渠道定位应用「渠道定义和渠道定位」的内容", "e862e845"),
    ("SOP 步骤②", "每个季度的第一天，更新表格：2026年渠道目标", "92932496"),
    ("步骤②要点", "2026年渠道目标，应用于制定全渠道的 GMV 目标和实收目标", "c3256de3"),
    ("步骤②要点", "根据 渠道定义 / B2B的GMV维度销售数据登记表 / 销售日报表，可得出渠道 GMV 销售进度和目标完成率", "6709b8f8"),
    ("约束", "全年总目标确定后不可被修改，每个季度可重新复盘一次季度目标", "0403287f"),
    ("统计维度", "销售日报表统计维度为 实收 / GMV 双维度（B2B 的 GMV 维度销售数据登记表覆盖：外贸组、分销组、线下组）", "cbd9f127 泛化项"),
    ("识别口径", "1) 以渠道编码和渠道名称的唯一性识别 UNOVE 全渠道销售额；2) 部门=一级、渠道=二级、店铺=三级；3) 渠道名称或部门有修改，以渠道编码为唯一识别", "cbd9f127"),
    ("定位逻辑(B2C)", "核心、正常和观察期渠道的分配直接与销售额、增长率和品牌要求挂钩", "0abc9d56"),
    ("定位逻辑(B2B)", "核心和正常分销渠道的划分，直接与实收和品牌要求挂钩", "bc1142b1"),
    ("增长要求", "渠道增长比例需根据品牌要求人工分配；核心直营/核心分销按比例高增长；正常直营/正常分销按比例增长（低于核心）", "69edd002"),
    ("豁免口径", "观察期直营渠道豁免；小红书因渠道与品牌特点保持在售即可，不要求按比例增长", "2f803613 / f35f399e"),
    ("计算公式", "渠道GMV销售进度 = 累计GMV(截至查询日)；目标完成率 = 累计GMV ÷ 该渠道年度GMV目标；实收同口径", "6709b8f8"),
    ("下游用途", "本 SOP 输出供同级节点「D：制定全渠道GMV目标」使用：根据历史GMV数据/渠道定位/全渠道销售趋势，分别制定所有渠道的GMV目标", "2b880f65 / 228d628c"),
]
for r in rules:
    ws2.append(list(r))
for row in ws2.iter_rows(min_row=2, max_row=ws2.max_row, max_col=3):
    for cell in row:
        cell.border = BORDER
        cell.font = Font(size=10)
        cell.alignment = Alignment(vertical="top", wrap_text=True)
for i, w in enumerate([22, 95, 20], 1):
    ws2.column_dimensions[get_column_letter(i)].width = w
ws2.freeze_panes = "A2"

# ---------------- Sheet 3 ----------------
ws3 = wb.create_sheet("数据缺口与动作")
ws3.append(["数据源", "形式", "链接/位置", "实测状态", "所需动作", "责任人(建议)"])
for c in range(1, 7):
    cell = ws3.cell(row=1, column=c)
    cell.fill = HDR_FILL
    cell.font = HDR_FONT
    cell.border = BORDER
    cell.alignment = Alignment(horizontal="center")
gaps = [
    ("销售日报表", "企业微信 smartsheet", "https://doc.weixin.qq.com/smartsheet/s3_AMwAoQZzAMECNeNTdk449SHW301Jo?tab=taDIvD",
     "登录墙：HTTP 200 但返回统一登录壳(120,113 字节)，无 13CHAN/UNOVE/GMV 任何数据", "在已登录企业微信的浏览器打开→导出全渠道日维度(GMV/实收)→粘贴或授权读取", "渠道运营(周中昱)+各渠道责任人"),
    ("2026年渠道目标", "企业微信 sheet", "https://doc.weixin.qq.com/sheet/e3_AbUAJQbFAEECNv1FFKAuoTra7QEAT?tab=BB08J2",
     "登录墙：同上，无数据", "打开后导出各渠道年度 GMV/实收目标列（17 个渠道编码）", "品牌/财务(陈华俊)"),
    ("B2B的GMV维度销售数据登记表", "导图内仅出现在「渠道定义和统计维度」泛化项，未挂外链", "节点 cbd9f127 泛化子树（外贸组/分销组/线下组）",
     "房间内 search_nodes 关键词命中 0 个独立节点，无数据表链接", "确认该登记表实际文档地址并补挂链接到节点 6709b8f8 下", "陈华俊"),
    ("导图本体数值", "无", "D 节点子树 102 个节点", "全子树 0 个 GMV/实收数值，仅有流程与口径", "由上述三表回填后重跑本 SOP 出「有数版执行单」", "WorkBuddy + 数据责任人"),
]
for r in gaps:
    ws3.append(list(r))
for row in ws3.iter_rows(min_row=2, max_row=ws3.max_row, max_col=6):
    for cell in row:
        cell.border = BORDER
        cell.font = Font(size=10)
        cell.alignment = Alignment(vertical="top", wrap_text=True)
for i, w in enumerate([24, 26, 62, 44, 50, 26], 1):
    ws3.column_dimensions[get_column_letter(i)].width = w
ws3.freeze_panes = "A2"

# ---------------- Sheet 4 ----------------
ws4 = wb.create_sheet("说明")
ws4.append(["项", "说明"])
ws4["A1"].fill = HDR_FILL
ws4["A1"].font = HDR_FONT
ws4["B1"].fill = HDR_FILL
ws4["B1"].font = HDR_FONT
notes = [
    ("执行 SOP", "D：历史GMV数据汇总分析（uid a591bb32-4095-4a6d-aa41-277853a89a1f）"),
    ("所属路径", "C：UN项目利润分 → P：品牌目标 → P：制定GMV目标 → D：历史GMV数据汇总分析"),
    ("房间", "room-xgoibqb8「UN项目工程」"),
    ("执行时间", "2026-09-14 17:04"),
    ("执行结论", "流程与渠道口径 100% 可取（导图内为真实数据）；三张数据表数值 0 条可取（企微登录墙/未挂链）→ 交付「口径已确认 + 填报模板待回填」版本"),
    ("未伪造声明", "本表数值列全部留空，未填入任何推测或示例数字；公式列已内置，回填 目标/累计 列后自动起算完成率"),
    ("数据来源", "mind-map MCP query_nodes 实测：房间 v1213，D 子树 102 节点全量拉取，渠道编码 17 个"),
]
for r in notes:
    ws4.append(list(r))
for row in ws4.iter_rows(min_row=2, max_row=ws4.max_row, max_col=2):
    for cell in row:
        cell.border = BORDER
        cell.font = Font(size=10)
        cell.alignment = Alignment(vertical="top", wrap_text=True)
ws4.column_dimensions["A"].width = 18
ws4.column_dimensions["B"].width = 110

wb.save(OUT)
print("SAVED", OUT)
