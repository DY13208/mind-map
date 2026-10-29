const crypto=require('crypto')
const service=require('./service')
function render(plan,nonce){
 const data=JSON.stringify(plan).replace(/</g,'\\u003c')
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>确认人事操作</title>
<style nonce="${nonce}">body{margin:0;background:#f5f7fa;color:#22324a;font:16px/1.6 system-ui,sans-serif}main{max-width:780px;margin:40px auto;padding:28px;background:white;border:1px solid #dae1ea;border-radius:12px}h1{font-size:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#f1f4f8}button{padding:12px 24px;background:#087f5b;color:white;border:0;border-radius:6px;font:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:default}label{display:block;margin:20px 0}#status{font-weight:600}small{overflow-wrap:anywhere}</style>
<main><h1>确认人事操作</h1><p>请核对当前账号、操作和全部参数。确认仅授权以下操作，15 分钟内有效；本页确认后由 Agent 执行。</p><p id="actor"></p><p id="effect"></p><small id="operation"></small><pre id="params"></pre><p id="expires"></p><label><input id="ack" type="checkbox">我已核对以上内容，确认授权本次操作</label><button id="confirm" disabled>确认本次操作</button><p id="status" role="status"></p></main>
<script nonce="${nonce}">const plan=${data};const el=id=>document.getElementById(id);el('actor').textContent='当前账号：'+plan.actor_name;el('effect').textContent='操作影响：'+plan.effect;el('operation').textContent=plan.operation;el('params').textContent=JSON.stringify(plan.params,null,2);el('expires').textContent='有效期至：'+new Date(plan.expires_at).toLocaleString();el('ack').onchange=()=>el('confirm').disabled=!el('ack').checked;el('confirm').onclick=async()=>{el('confirm').disabled=true;el('ack').disabled=true;try{const response=await fetch('/api/integrations/hrms/agent/confirm',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan_id:plan.plan_id,confirmation_hash:plan.confirmation_hash,nonce:plan.nonce})});const result=await response.json();if(!response.ok)throw Error(result.error||'确认失败');el('status').textContent='已确认。请返回 Agent 继续执行本次操作。';}catch(error){el('status').textContent=error.message+'；请重新打开确认页面。';}};</script></html>`
}
async function handle(req,res,{url,db,readBody,sendJson}){
 if(url.pathname!=='/api/integrations/hrms/agent/confirm')return false
 res.setHeader('Cache-Control','no-store')
 res.setHeader('Referrer-Policy','no-referrer')
 res.setHeader('X-Content-Type-Options','nosniff')
 try{
  if(req.method==='GET'){
   const plan=await service.confirmationPage(db,req,url.searchParams.get('plan_id'))
   const nonce=crypto.randomBytes(18).toString('base64')
   res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`)
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(render(plan,nonce))
  }else if(req.method==='POST')sendJson(res,200,{ok:true,item:await service.confirmFromPage(db,req,await readBody(req))})
  else sendJson(res,405,{ok:false,error:'不支持的方法'})
 }catch(e){sendJson(res,e.statusCode||400,{ok:false,code:e.code||'HRMS_CONFIRMATION_ERROR',error:e.message})}
 return true
}
module.exports={handle,render}
