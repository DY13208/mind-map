const fs=require('fs'),crypto=require('crypto'),path=require('path');
function walk(dir,base=dir,out={}){if(!fs.existsSync(dir))return out;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);const rel=path.relative(base,p).replace(/\\/g,'/');if(e.isDirectory())walk(p,base,out);else{out[rel]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}return out;}
const pre=JSON.parse(fs.readFileSync('integrations/openwiki/phase2a/artifacts/canonical-hash-pre-ingest.json','utf8'));
const now={};
for(const r of ['ow-p2a-room-a','ow-p2a-room-b']) now[r]=walk(path.join('knowledge',r));
fs.writeFileSync('integrations/openwiki/phase2a/artifacts/canonical-hash-post.json',JSON.stringify(now,null,2));
const report={roomB_unchanged: JSON.stringify(pre['ow-p2a-room-b'])===JSON.stringify(now['ow-p2a-room-b']), roomA_diff:{}, roomB_diff:{}};
for(const k of new Set([...Object.keys(pre['ow-p2a-room-a']||{}),...Object.keys(now['ow-p2a-room-a']||{})])){
  if(pre['ow-p2a-room-a'][k]!==now['ow-p2a-room-a'][k]) report.roomA_diff[k]={before:pre['ow-p2a-room-a'][k]||null,after:now['ow-p2a-room-a'][k]||null};
}
for(const k of new Set([...Object.keys(pre['ow-p2a-room-b']||{}),...Object.keys(now['ow-p2a-room-b']||{})])){
  if(pre['ow-p2a-room-b'][k]!==now['ow-p2a-room-b'][k]) report.roomB_diff[k]={before:pre['ow-p2a-room-b'][k]||null,after:now['ow-p2a-room-b'][k]||null};
}
fs.writeFileSync('integrations/openwiki/phase2a/artifacts/canonical-ro-check.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
