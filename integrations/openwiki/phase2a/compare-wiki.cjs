const fs=require('fs'),crypto=require('crypto'),path=require('path');
function walk(dir,base=dir,out={}){if(!fs.existsSync(dir))return out;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);const rel=path.relative(base,p).replace(/\\/g,'/');if(e.isDirectory())walk(p,base,out);else if(!rel.includes('large_tool_results/')){out[rel]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}return out;}
const before=JSON.parse(fs.readFileSync('integrations/openwiki/phase2a/artifacts/wiki-hash-ingest1.json','utf8'));
const after=walk('integrations/openwiki/phase2a/artifacts/wiki-ingest2-noop');
fs.writeFileSync('integrations/openwiki/phase2a/artifacts/wiki-hash-ingest2-noop.json',JSON.stringify(after,null,2));
const changed=[],added=[],removed=[];
for(const k of Object.keys(after)){if(!(k in before))added.push(k);else if(before[k]!==after[k])changed.push(k);}
for(const k of Object.keys(before)){if(!(k in after))removed.push(k);}
const report={changed,added,removed,identical:changed.length===0&&added.length===0&&removed.length===0};
fs.writeFileSync('integrations/openwiki/phase2a/artifacts/noop-diff.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
