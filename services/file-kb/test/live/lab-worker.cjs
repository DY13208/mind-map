'use strict'
// Failure/restart child used only by batch-acceptance. Never reads .env.
const path=require('path')
const root=process.env.KB_LAB_ROOT,storageRoot=process.env.KB_LAB_STORAGE_ROOT
if(!root||!storageRoot||!path.resolve(root).startsWith('D:\\File-KB-Lab-')||!path.resolve(storageRoot).startsWith(path.resolve(root)+path.sep))throw new Error('isolated storage required')
const {Pool}=require('pg'),{createWorker}=require('../../src/worker'),{loadConfig}=require('../../src/config'),{createDoclingClient}=require('../../src/docling/client')
const config=loadConfig({FILE_KB_ENABLED:'true',KB_STORAGE_ROOT:storageRoot,KB_NATIVE_LIGHT_PARSE:'true',KB_LEASE_MS:'2000',KB_WORKER_CONCURRENCY:'2',KB_POLL_MS:'50'})
const pool=new Pool({host:'127.0.0.1',port:25439,user:'postgres',database:'kb_lab',application_name:'file-kb-lab-restart'})
const worker=createWorker({pool,config,docling:createDoclingClient({baseUrl:'http://127.0.0.1:25019',totalTimeoutMs:180000,doOcr:false}),log:()=>{}})
worker.runOne().then(async result=>{console.log(JSON.stringify({result}));await pool.end()}).catch(async e=>{console.error(e.message);await pool.end();process.exitCode=1})
