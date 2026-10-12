const { shareholderName } = require('./fillFacts')
const normal = value => String(value || '').normalize('NFKC').replace(/<[^>]*>/g,'').replace(/\s/g,'').toLowerCase()
const variants = value => String(value || '').split('/').map(normal).filter(Boolean)
function sections(pages) {
  const offsets = []
  let offset=0
  const text=pages.map(p=>{offsets.push({offset,page:p.page ?? null,text:String(p.text||'')});offset+=String(p.text||'').length+1;return p.text||''}).join('\n')
  const markers=[...text.matchAll(/公司名称\s*[：:]/g)], result=[]
  for(let i=0;i<markers.length;i++) {
    const marker=markers[i], end=markers[i+1]?.index ?? text.length
    const block=text.slice(marker.index+marker[0].length,end)
    const field=block.match(/股东情况\s*[：:]/)
    if(!field)continue
    const company=block.slice(0,field.index).replace(/<[^>]*>/g,'').replace(/\r?\n/g,' ').trim()
    // A declared name may not absorb another heading or unrelated explanatory paragraph.
    if(!company || company.length>180 || /[\n：:]/.test(company))continue
    const start=marker.index+marker[0].length+field.index+field[0].length
    const page=offsets.slice().reverse().find(p=>p.offset<=start)
    result.push({company,body:block.slice(field.index+field[0].length),quote:text.slice(marker.index,end).trim(),page:page?.page ?? null,line:page ? text.slice(page.offset,start).split('\n').length : null})
  }
  return result
}
function summaryCompanyNames(pages) {return [...new Set(sections(pages).map(s=>s.company))]}
function summaryCompany(titles,names) {
  return titles.slice(0,-1).reverse().find(title=>variants(title).some(v=>names.some(n=>normal(n)===v))) || ''
}
function summaryShareholders(pages,company) {
  const result=[]
  for(const section of sections(pages)) {
    if(!variants(company).includes(normal(section.company)))continue
    const body=section.body.replace(/\$([^$]*)\$/g,'$1').replace(/\\%/g,'%').replace(/\n(?:大陆|韩国|香港|越南)\s*(?:\n|$)[\s\S]*$/,'').split(/\n\s*[\u4e00-\u9fff]{2,20}[：:]/)[0].replace(/[一二三四五六七八九十]+、\s*$/,'').trim()
    for(const clause of body.split(/[；;]/)) {
      const head=clause.split(/[，,]/)[0].replace(/(?:均为|为|是)公司股东[\s\S]*$/,'').replace(/(?:员工代持|外部人士持股|员工持股)[\s\S]*$/,'').trim()
      const names=head.split('、').map(n=>n.trim()).filter(n=>!/^(?:不明|不详|未知|待定|待确认|尚未确定|无法确认|匿名|某人|员工|外部人士|自然人|法人|个人|公司|企业)(?:$|人士|人员|股东|姓名|信息)/.test(n)).map(shareholderName).filter(Boolean)
      const ratio=clause.match(/持股\s*(\d+(?:\.\d+)?)\s*%/)
      for(const owner of names) {
        const proportion=names.length===1 && ratio && Number(ratio[1])<=100 ? Number(ratio[1])+'%' : ''
        result.push({text:'股东：'+owner+(proportion?'；持股'+proportion:''),owner,values:proportion?{比例:proportion}:{},date:'',quote:section.quote,page:section.page,line:section.line,summary:true,dateKind:'unknown',matchBasis:'company-shareholder-summary'})
      }
    }
  }
  return result
}
function summaryDisagrees(rows) {
  const groups=new Map(), other=new Set()
  for(const row of rows) {
    const owner=row.owner || shareholderName(row.text)
    if(!owner)continue
    if(!row.summary) {other.add(normal(owner));continue}
    const group=(row.file || row.sourceTitle || '')+'\n'+row.quote
    if(!groups.has(group))groups.set(group,new Set())
    groups.get(group).add(normal(owner))
  }
  const sets=[...groups.values()]
  if(!sets.length)return false
  if(other.size)sets.push(other)
  return new Set(sets.map(set=>JSON.stringify([...set].sort()))).size>1
}
module.exports={summaryCompanyNames,summaryCompany,summaryShareholders,summaryDisagrees}
