# Regenerates sample.pdf / sample.xlsx (needs: pip install reportlab openpyxl)
import datetime, openpyxl
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors
ss = getSampleStyleSheet()
doc = SimpleDocTemplate('sample.pdf', pagesize=A4, title='KB Sample')
data = [['SKU', 'Product', 'Price', 'Stock', 'Date'], ['KB-1001', 'Widget A', '12.50', '140', '2026-09-01'],
        ['KB-1002', 'Widget B', '8.99', '0', '2026-09-15'], ['KB-2001', 'Gadget X', '199.00', '23', '2026-10-02']]
t = Table(data)
t.setStyle(TableStyle([('GRID', (0, 0), (-1, -1), 0.5, colors.black), ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey)]))
doc.build([Paragraph('Quarterly Inventory Report', ss['Title']), Paragraph('1. Overview', ss['Heading1']),
           Paragraph('This report lists inventory for the File KB end-to-end test. Widgets are sold in units.', ss['Normal']),
           Spacer(1, 12), Paragraph('2. Inventory table', ss['Heading1']), t, PageBreak(),
           Paragraph('3. Notes', ss['Heading1']), Paragraph('Second page paragraph mentioning SKU KB-2001 restock schedule.', ss['Normal'])])
wb = openpyxl.Workbook(); ws = wb.active; ws.title = '库存'
ws.append(['商品编码', '商品名称', '单价', '库存数量', '入库日期', '备注'])
for r in [('SKU-A001', '螺丝刀', 12.5, 100, datetime.date(2026, 9, 1), '常规'), ('SKU-A002', '扳手', 35, 0, datetime.date(2026, 9, 12), None),
          ('SKU-B010', '电钻', 299.9, 7, datetime.date(2026, 10, 3), '促销'), ('SKU-B011', '电池', 19.0, 250, datetime.date(2026, 10, 8), '')]:
    ws.append(list(r))
ws2 = wb.create_sheet('Prices'); ws2.append(['SKU', 'Price', 'Qty', 'Date'])
ws2.append(['EN-1', '￥1,234.50', '12', '2026/10/01']); ws2.append(['EN-2', 'abc', 'x', 'not a date'])
wb.save('sample.xlsx')
