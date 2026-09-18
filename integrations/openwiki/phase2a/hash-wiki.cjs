const fs=require('fs'),crypto=require('crypto'),path=require('path');
function walk(dir,base=dir,out={}){if(!fs.existsSync(dir))return out;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);const rel=path.relative(base,p).replace(/\\/g,'/');if(e.isDirectory())walk(p,base,out);else if(!rel.includes('large_tool_results/')){out[rel]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}return out;}
const root='integrations/openwiki/phase2a/artifacts/wiki-ingest1-vol';
const h=walk(root);
fs.writeFileSync('integrations/openwiki/phase2a/artifacts/wiki-hash-ingest1.json',JSON.stringify(h,null,2));
console.log(Object.keys(h).length+' files');
console.log(JSON.stringify(h,null,2));
