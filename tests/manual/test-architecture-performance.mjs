/** 中文隔离性能对比：本机假上游、模拟用量、独立子进程，不访问生产实例。 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
const stageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const baseRoot = process.env.LITE_CCSWITCH_TEST_BASELINE;
if (!baseRoot) throw new Error("请用 LITE_CCSWITCH_TEST_BASELINE 指定只读基线源码或版本包；所有测试数据独立生成");
const { createUsageQueries } = await import(path.join(stageRoot,"lib/usage-queries.js"));
const { normalizeUsageRecord } = await import(path.join(stageRoot,"lib/usage-records.js"));
const rows = (n) => Array.from({length:n},(_,i)=>({id:`r-${i}`,groupId:"default",providerId:"p",providerName:"性能模拟",timestamp:new Date(Date.now()-i*1000).toISOString(),statusCode:200,inputTokens:2,outputTokens:3,totalTokens:5,estimatedCostUsd:0}));
const synthetic = [];
for (const n of [50_000,200_000]) {
 const records=rows(n); const queries=createUsageQueries({getRecords:()=>records,normalizeUsageRecord});
 let t=performance.now(); const summary=queries.summary({groupId:"default",timezoneOffset:-480});const cold=performance.now()-t;
 t=performance.now(); const cached=queries.summary({groupId:"default",timezoneOffset:-480});const warm=performance.now()-t;
 assert.equal(summary.totalTokens,n*5);assert.equal(cached,summary);
 synthetic.push({records:n,coldMs:cold,cachedMs:warm,cache:queries.state()});
}
async function listen(server){await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));return server.address().port;}
const upstream=createServer(async(req,res)=>{for await(const chunk of req){}res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:crypto.randomUUID(),status:"completed",usage:{input_tokens:1,output_tokens:1}}));});
import crypto from "node:crypto";
const upstreamPort=await listen(upstream);const runs=[];
try {
 for(const [label,root] of [["baseline",baseRoot],["candidate",stageRoot]]){
  const data=await mkdtemp(path.join(os.tmpdir(),"lite-performance-"));let child;
  try{
   const reservation=createServer();const port=await listen(reservation);await new Promise(r=>reservation.close(r));
   await writeFile(path.join(data,"config.json"),JSON.stringify({version:2,providers:[{id:"p",name:"性能模拟",apiKey:"fake",baseUrl:`http://127.0.0.1:${upstreamPort}`,routingEnabled:true}],connectivityTest:{periodicIntervalMs:null}}));
   await writeFile(path.join(data,"usage.jsonl"),rows(200_000).map(JSON.stringify).join("\n")+"\n");
   const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("LITE_CCSWITCH_")));
   child=spawn(process.execPath,[path.join(root,"server.js")],{cwd:root,env:{...env,LITE_CCSWITCH_DATA_DIR:data,LITE_CCSWITCH_HOST:"127.0.0.1",LITE_CCSWITCH_PORT:String(port)},stdio:"ignore"});
   const base=`http://127.0.0.1:${port}`;
   for(let i=0;i<300;i++){try{if((await fetch(base+"/api/status")).ok)break;}catch{}await new Promise(r=>setTimeout(r,25));}
   const summaryMs=[];let summaryBytes=0;
   for(let i=0;i<4;i++){const start=performance.now();const text=await fetch(base+"/api/billing/summary?groupId=default&timezoneOffset=-480").then(r=>r.text());summaryMs.push(performance.now()-start);summaryBytes=Buffer.byteLength(text);}
   const logPath=label==="baseline"?"/api/billing/logs?limit=5000&groupId=default":"/api/billing/logs?page=1&pageSize=30&groupId=default";
   const logText=await fetch(base+logPath).then(r=>r.text());
   const concurrentStart = performance.now();
   const coldSummary = fetch(base+"/api/billing/summary?groupId=default&providerId=p&timezoneOffset=-480").then(r=>r.text());
   await new Promise(resolve=>setTimeout(resolve,5));
   const businessStart = performance.now();
   const duringSummary = await fetch(base+"/v1/responses",{method:"POST",headers:{"content-type":"application/json","x-codex-session-id":"during-summary"},body:JSON.stringify({model:"fake",input:"并发汇总测试"})});
   const concurrentBusinessFirstByteMs = performance.now()-businessStart;
   assert.equal(duringSummary.status,200); await duringSummary.text(); await coldSummary;
   const concurrentSummaryWallMs = performance.now()-concurrentStart;
   const latencies=[];
   for(let i=0;i<25;i++){const start=performance.now();const response=await fetch(base+"/v1/responses",{method:"POST",headers:{"content-type":"application/json","x-codex-session-id":`p-${i}`},body:JSON.stringify({model:"fake",input:"本机性能测试"})});assert.equal(response.status,200);latencies.push(performance.now()-start);await response.text();}
   latencies.sort((a,b)=>a-b);runs.push({label,summaryMs,summaryBytes,logBytes:Buffer.byteLength(logText),concurrentBusinessFirstByteMs,concurrentSummaryWallMs,proxyFirstByteP95Ms:latencies[Math.ceil(latencies.length*.95)-1]});
  }finally{if(child&&child.exitCode===null){const done=once(child,"exit");child.kill("SIGTERM");await done;}await rm(data,{recursive:true,force:true});}
 }
}finally{upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
assert.ok(runs[1].proxyFirstByteP95Ms-runs[0].proxyFirstByteP95Ms<1000);
assert.ok(runs[1].concurrentBusinessFirstByteMs < 1000, "大历史冷汇总期间业务首包应在 1 秒内返回");
console.log(JSON.stringify({synthetic,runs},null,2));
