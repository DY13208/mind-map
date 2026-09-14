const fs = require('fs')
const file = 'web/src/pages/SopRegistry/Index.vue'
let s = fs.readFileSync(file, 'utf8')
// Remove the two old run-dialog blocks, leaving other dialogs untouched.
for (let n = 0; n < 2; n++) {
  const start = s.indexOf('.sopRunDialog {', s.indexOf('<style'))
  let end = start + '.sopRunDialog {'.length, depth = 1
  for (; depth && end < s.length; end++) {
    if (s[end] === '{') depth++
    if (s[end] === '}') depth--
  }
  if (start < 0 || depth) throw new Error('Cannot locate old dialog style')
  s = s.slice(0, start) + s.slice(end)
}
s = s.replace('body.isDark .sopRunDialog,\n.sopRunDialog,\n', '')
s = s.replace('body.isDark .sopRunDialog,\r\n.sopRunDialog,\r\n', '')
s = s.trimEnd() + '\n\n<style lang="less" src="./sopRunDialog.less"></style>\n'
fs.writeFileSync(file, s)
