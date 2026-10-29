const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const source=fs.readFileSync(path.join(__dirname,'../src/runtimePublicPath.js'),'utf8')
for(const [runtime,expected] of [['/','/'],['/portal','/portal/'],['./dist/','./dist/'],['','dist/']]){
 const sandbox={window:{externalPublicPath:runtime},__webpack_public_path__:'dist/'}
 vm.runInNewContext(source,sandbox)
 assert.equal(sandbox.__webpack_public_path__,expected)
}
const entry=fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8')
assert.ok(entry.indexOf("import './runtimePublicPath'")<entry.indexOf("import App"),'runtime path must execute before application imports')
console.log('PASS: runtime lazy-chunk paths override stale build paths before App imports')
