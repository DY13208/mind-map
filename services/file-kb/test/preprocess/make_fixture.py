"""Generate a BIFF fixture; xlwt is test-only, never installed in the application image."""
import datetime
import sys
import xlwt
wb = xlwt.Workbook()
sheet = wb.add_sheet('明细表')
for col, value in enumerate(['商品编码', '数量', '日期']):
    sheet.write(0, col, value)
for row in (1, 2, 4):
    sheet.write(row, 0, 'SKU-' + str(row))
    sheet.write(row, 1, row * 10)
    sheet.write(row, 2, datetime.datetime(2024, 5, 6), xlwt.easyxf(num_format_str='YYYY-MM-DD'))
wb.add_sheet('附表').write(0, 0, '备注')
wb.save(sys.argv[1])
