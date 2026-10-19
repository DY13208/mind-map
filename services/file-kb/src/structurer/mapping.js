'use strict'
const {httpError}=require('../errors')
const {combineHeaders}=require('./header')
// Version 2 sends only deliberate renames in columnOverrides. Legacy snapshots
// must not overwrite freshly selected headers when the selected rows change.
// An unchanged header selection keeps saved custom names even when the client
// repeats them, or sends an empty override list.
function sameRows(a,b){return JSON.stringify(a||[])===JSON.stringify(b||[])}
function rawHeaders(source,detected){
  if(source.selectedRows && source.selectedRows.length){
    return combineHeaders(source.selectedRows.map(r=>({number:r.row,values:r.values||[]})),[])
  }
  return detected.headers||[]
}
function savedCustom(saved,raw){
  const out=[]
  ;(saved.headers||[]).forEach((name,index)=>{if(name && name!==raw[index])out.push({index,name})})
  return out
}
function normalizeMappings(sheets,preview,previous){
  if(new Set(sheets.map(s=>s.sheet)).size!==sheets.length)throw httpError(400,'bad_layout')
  return sheets.map(s=>{
    const source=preview.sheets.find(x=>x.name===s.sheet)
    if(!source || s.headerRows.some(n=>n>source.rowCount) || s.dataStartRow>source.rowCount+1)throw httpError(400,'bad_layout')
    if(source.selectedRows && s.headerRows.some(n=>!source.selectedRows.find(r=>r.row===n)?.values.some(v=>v!=null&&String(v).trim()!=='')))throw httpError(400,'empty_header')
    const saved=previous?.sheets?.find(x=>x.sheet===s.sheet)?.regions?.[0]
    const detected=source.regions[0]||{headerRows:[],headers:[]}
    const savedConfirmed=saved&&saved.confirmed?saved:null
    const base=savedConfirmed||detected
    const same=sameRows(base.headerRows,s.headerRows)
    const preserved=same&&savedConfirmed?savedCustom(savedConfirmed,rawHeaders(source,detected)):[]
    const byIndex=new Map(preserved.map(c=>[c.index,c]))
    let columns
    if(s.columnOverrides!=null){for(const c of s.columnOverrides)byIndex.set(c.index,c);columns=[...byIndex.values()]}
    else if(!same)columns=[]
    else if(savedConfirmed){
      for(const c of s.columns||[])if(c&&c.name!==(savedConfirmed.headers||[])[c.index])byIndex.set(c.index,c)
      columns=[...byIndex.values()]
    }else columns=(s.columns||[]).filter(c=>c.name!==base.headers?.[c.index])
    columns.sort((a,b)=>a.index-b.index)
    if(source.columnCount!=null && columns.some(c=>c.index>=source.columnCount))throw httpError(400,'bad_column_override')
    return {sheet:s.sheet,headerRows:s.headerRows,dataStartRow:s.dataStartRow,columns,mappingVersion:2,legacyColumnsIgnored:s.columnOverrides==null&&!same&&!!s.columns?.length}
  })
}
module.exports={normalizeMappings}
