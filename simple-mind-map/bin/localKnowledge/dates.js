const digits={'〇':'0','零':'0','○':'0','O':'0','o':'0','Ｏ':'0','一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9'}
function number(text){if(/^\d+$/.test(text))return Number(text);const parts=text.split('十');if(parts.length===2)return (parts[0]?Number(digits[parts[0]]):1)*10+(parts[1]?Number(digits[parts[1]]):0);return Number(digits[text])}
function dates(text) {
  const result=[]
  for(const m of String(text).matchAll(/([12一二][\d〇零○OoＯ一二三四五六七八九]{3})\s*年\s*([\d一二三四五六七八九十]{1,3})\s*月\s*([\d一二三四五六七八九十]{1,3})\s*日/g)){
    const year=Number([...m[1]].map(c=>digits[c]??c).join('')),month=number(m[2]),day=number(m[3]),d=new Date(Date.UTC(year,month-1,day))
    if(year>=1900&&year<=2100&&d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day)result.push(`${year}年${month}月${day}日`)
  }
  for(const m of String(text).matchAll(/((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/g)){
    const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));if(d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3])result.push(`${m[1]}年${+m[2]}月${+m[3]}日`)
  }
  return [...new Set(result)]
}
function documentDate(pages) {
  const text=pages.map(p=>p.text||'').join('\n'),issued=dates((text.match(/(?:我局已于|核准日期|登记日期|备案日期|发证日期|签发日期|日期)[：:\s]*[^\n]{0,80}/g)||[]).join('\n'))
  if(issued.length===1)return issued[0]
  const all=dates(text);return all.length===1?all[0]:''
}
module.exports={dates,documentDate}
