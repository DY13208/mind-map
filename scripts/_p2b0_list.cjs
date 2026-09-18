const fs=require('fs');const path=require('path');
const roots=['scripts','web','simple-mind-map','docker','docs','integrations'];
const hit=[];
function walk(d,depth=0){
  if(depth>5||!fs.existsSync(d))return;
  let ents;try{ents=fs.readdirSync(d,{withFileTypes:true})}catch{return}
  for(const e of ents){
    if(e.name==='node_modules'||e.name==='.git'||e.name==='dist'||e.name==='dist-build')continue;
    const p=path.join(d,e.name);
    if(e.isDirectory())walk(p,depth+1);
    else if(/\.(js|ts|mjs|cjs|vue|md|yml|json)$/i.test(e.name)){
      const low=e.name.toLowerCase();
      if(/openclaw|bridge|assistant|wecom|wechat|identity|requester|mcp/.test(low)||/openclaw|bridge/.test(d.toLowerCase()))
        hit.push(p);
    }
  }
}
for(const r of roots)walk(r);
console.log(hit.sort().join('\n'));
console.log('COUNT',hit.length);
