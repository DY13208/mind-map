// Shared by the browser and local document service; never use compiler metadata as evidence.
function visibleText(value) {
  let text=String(value||'').replace(/\\([<>!])/g,'$1').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&amp;/gi,'&')
  text=text.replace(/<!--[\s\S]*?-->/g,'').replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi,'').replace(/<[^>]*>/g,'').replace(/^#{1,6}\s+/,'').replace(/^[-*•]\s+/,'').replace(/\*\*/g,'').trim()
  if(/^(?:来源脑图|来源文件|roomId|章节|原文(?:（行\s*\d+）)?|页码|提取方式)[：:]/.test(text))return ''
  if(/mindmap:node=/.test(text)||/^\|?\s*:?-{3,}/.test(text))return ''
  if(/^\|.*\|$/.test(text))text=text.split('|').map(s=>s.trim()).filter(Boolean).join(' ')
  return text.replace(/&nbsp;/gi,' ').trim()
}
function factKey(value,field,owner='') {
  const text=visibleText(value)
  if(!text)return ''
  if(field==='股东')owner=shareholderName(text)||owner
  const dates=(text.match(/(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)/g)||[]).join('|')
  let key=text.replace(/^资料日期(?:未确认|[：:])?[；;\s]*/,'').replace(/(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)/g,'').replace(/\s/g,'').replace(/[：:，,；;、|]/g,'').replace(/(\d+(?:\.\d+)?)%/g,(_,n)=>Number(n)+'%')
  if(field==='股东')key=key.replace(/^(?:名称或姓名|股东姓名或名称|股东姓名|股东名称|股东)/,'姓名').replace(/(?:出资|岀资|持股)比例|占比|持股(?=\d)/g,'比例').replace(/认缴(?:出资额|出资|金额)/g,'认缴').replace(/实缴(?:出资额|出资|金额)/g,'实缴').replace(/(\d+(?:\.\d+)?)万元/g,(_,n)=>Number(n)*10000+'元')
  if(field==='股东' && key===owner)key='姓名'+owner
  if(field==='法人代表')key=key.replace(/^(?:公司)?(?:法人代表|法定代表人)/,'')
  if(field==='注册地址')key=key.replace(/^(?:第[一二三四五六七八九十\d]+条)?(?:公司)?(?:注册地址|注册住所|住所)/,'')
  if(field==='注册资本') {
    const amount=text.match(/([\d,]+(?:\.\d+)?)\s*(万美元|万港元|万元|万|美元|港元|欧元|日元|元)/)
    if(amount)key=capitalCurrency(text,amount[2]==='万'?'UNSPECIFIED':'CNY')+':'+Number(amount[1].replace(/,/g,''))*(amount[2].startsWith('万')?10000:1)
    else key=key.replace(/^(?:注册资本|注册资金)/,'')
  }
  return dates+'|'+owner+'|'+key
}
function capitalCurrency(text,fallback='CNY') {
  for(const [currency,re] of [['USD',/美元|美金|USD/i],['HKD',/港币|港元|HKD/i],['EUR',/欧元|EUR/i],['JPY',/日元|JPY/i],['CNY',/人民币|CNY|RMB/i]])if(re.test(text))return currency
  return fallback
}
function unavailableName(value) {
  return /^(?:无|无信息|无记录|不适用|未知|不详|待核实|暂无|未提供|未披露|待填写|待补充)(?:$|[（(：:])/.test(value)||/^(?:详见|参见|参考|见附件|见附表|见章程)/.test(value)||/^以.+为准$/.test(value)||/^(?:自然人|法人|个人|股东资料|股东信息|股东名称|股东姓名|自然人股东|法人股东|控股股东|主要股东|唯一股东|出资人|投资人|有限责任公司|股份有限公司|合伙企业|联系信息|联系方式|联系电话|股东类型|企业类型|资料|信息|姓名|名称|证明)$/.test(value)
}
function shareholderName(text) {
  const value=visibleText(text).replace(/^资料日期[：:]\s*/,'').replace(/^(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)[；;\s]*/,'')
  const labelled=value.match(/^(?:名称或姓名|股东姓名或名称|股东姓名|股东名称|股东)[：:\s]+(.+)/)?.[1]
  if(labelled){const name=labelled.replace(/[，,；;：:\s（(]+(?:持股|认缴|实缴|出资|比例|占比|住所|住址|身份证|法定代表人|法人代表|联系人|联系电话|电话|手机|邮箱)[\s\S]*$/,'').trim();return unavailableName(name)?'':name}
  if(unavailableName(value))return ''
  if(/^(?:名称或姓名|股东姓名或名称|股东姓名|股东名称|股东|姓名|名称)$/.test(value))return ''
  if(/^[\u4e00-\u9fffA-Za-z0-9·（）() .,&-]{2,120}(?:有限公司|股份公司|合伙企业|Limited|Ltd\.?)$/i.test(value))return value
  return /^[\u4e00-\u9fff·]{2,10}$/.test(value)&&!/股东|认缴|实缴|出资|方式|货币|比例|资本|持股|董事|监事|经理|会议|应当|有权|备注|联系人|未知|不详|待核实|暂无|未提供|未披露|待填写|待补充|依据|依照|根据|公司法|权利|义务/.test(value)&&!/^(自然人|法人|资料|信息|姓名|名称|证明)$/.test(value)?value:''
}
function presentFillTrees(trees,titles,confirmedNames={}) {
  const field=titles[titles.length-1]
  if(field!=='股东')return trees
  const company=titles.slice(0,-1).reverse().find(t=>/公司|Limited|Co\.,?\s*Ltd/i.test(t))
  const seen=new Set(),result=[]
  for(const tree of trees) {
    const name=tree.data?.autoFill?.owner || shareholderName(tree.data?.text)
    if(!name || unavailableName(name))continue
    const date=String(tree.data.text).match(/(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)/)?.[0]||''
    const confirmed=confirmedNames[company]
    const names=!date&&Array.isArray(confirmed)?confirmed:[confirmed && !Array.isArray(confirmed) && typeof confirmed[name]==='string'?confirmed[name]:name]
    for(const value of names) {
      const text=(date?date+'；':'')+value,key=factKey(text,field)
      if(seen.has(key))continue
      seen.add(key)
      result.push({data:{text,autoFill:{version:2,field,key,presentation:'name',owner:value}},children:[]})
    }
  }
  return result
}
function factKeys(texts,field) {
  let owner=''
  return texts.map(text=>{if(field==='股东')owner=shareholderName(text)||owner;return factKey(text,field,owner)})
}
function factsConflict(texts,field) {
  const scalar=new Map(),sole=new Map(),amounts=new Map(),owners=new Map()
  for(const raw of texts) {
    const text=visibleText(raw),date=text.match(/(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)/)?.[0]||''
    if(['注册地址','注册资本','法人代表'].includes(field)){const key=factKey(text,field);if(scalar.has(date)&&scalar.get(date)!==key)return true;scalar.set(date,key);continue}
    if(field!=='股东')continue
    const owner=shareholderName(text)||owners.get(date)||''
    if(owner)owners.set(date,owner)
    const ratio=text.match(/(\d+(?:\.\d+)?)\s*%/)
    if(owner&&ratio&&Number(ratio[1])===100){const set=sole.get(date)||new Set();set.add(owner);sole.set(date,set);if(set.size>1)return true}
    for(const [kind,re] of [['比例',/(\d+(?:\.\d+)?)\s*%/],['认缴',/认缴(?:出资额|出资|金额)?[：:\s]*([\d.]+)\s*(万元|元)/],['实缴',/实缴(?:出资额|出资|金额)?[：:\s]*([\d.]+)\s*(万元|元)/]]){
      const match=text.match(re);if(!owner||!match)continue
      const key=date+'|'+owner+'|'+kind,value=Number(match[1])*(match[2]==='万元'?10000:1)
      if(amounts.has(key)&&amounts.get(key)!==value)return true
      amounts.set(key,value)
    }
  }
  return false
}
function isAutomaticNote(note) {
  return !!note && String(note).split('\n\n').every(part=>/^来源文件：[^\n]+\n页码：\d+；行号：\d+\n提取方式：[^\n]+\n原文：[^\n]*$/.test(part) || /^来源脑图：[^\n]+\n(?:roomId：[^\n]*\n)?章节：[^\n]*\n原文(?:（行 \d+）)?：[^\n]*$/.test(part))
}
function cleanupNodes(nodes) {
  const byId=new Map(nodes.map(n=>[n.uid,n])),parents=new Set(nodes.map(n=>n.parentId)),seen=new Map(),owners=new Map(),deletes=[],updates=[]
  let preserved=0
  for(const node of nodes) {
    const data=node.data||{},generated=data.autoFill?.version===2||isAutomaticNote(data.note)
    if(!generated)continue
    if(parents.has(node.uid)||data.image||data.attachmentId||data.attachmentUrl||data.attachmentName||data.hyperlink||data.note && !isAutomaticNote(data.note)){preserved++;continue}
    const field=visibleText(byId.get(node.parentId)?.data?.text)
    const owner=shareholderName(data.text)||owners.get(node.parentId)||''
    if(field==='股东')owners.set(node.parentId,owner)
    const key=factKey(data.text,field,field==='股东'?owner:'')
    if(!data.autoFill && data.note) {
      const original=String(data.note).match(/\n原文(?:（行 \d+）)?：([^\n]*)/)?.[1] || ''
      const withoutDate=value=>visibleText(value).replace(/^(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)[；;\s]*/,'')
      if(factKey(withoutDate(original),field)!==factKey(withoutDate(data.text),field)){preserved++;continue}
    }
    if(data.autoFill?.key && data.autoFill.key!==key){preserved++;continue}
    const group=node.parentId+'|'+key
    if(!key || seen.has(group)){deletes.push(node.uid);continue}
    seen.set(group,node.uid)
    updates.push({uid:node.uid,data:{note:'',autoFill:{version:2,field,key}}})
  }
  return {deletes,updates,preserved}
}
module.exports={visibleText,factKey,factKeys,factsConflict,isAutomaticNote,cleanupNodes,presentFillTrees,capitalCurrency}
