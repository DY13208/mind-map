// Content only: expanding/collapsing and transient collaboration metadata do not edit a definition.
const keys = ['text','richText','note','hyperlink','hyperlinkTitle','image','icon','tag','attachmentId','attachmentIds','knowledgeFiles','checkbox']
function contentData(data = {}) {
  return Object.fromEntries(keys.filter(k => data[k] !== undefined).map(k => [k,data[k]]))
}
module.exports = {contentData}
