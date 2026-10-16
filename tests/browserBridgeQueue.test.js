"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");

function backgroundFixture() {
 const jobs=[1,2].map(id=>({id:String(id),radar_id:1,source:"olx",query:"sony handycam",source_query:"sony handycam",url:"https://www.olx.com.br/brasil?q=sony",attempts:0}));
 const state={autoBrowseEnabled:true,autoCaptureEnabled:true,autoBrowseQueue:jobs,autoBrowseLastEnqueuedByRadar:{}};
 const event=()=>({addListener(){},removeListener(){}});
 const chrome={storage:{local:{async get(keys){if(Array.isArray(keys))return Object.fromEntries(keys.map(k=>[k,state[k]]));return {...keys,...state};},async set(update){Object.assign(state,update);}}},alarms:{async get(){return {};},create(){},onAlarm:event()},runtime:{onInstalled:event(),onStartup:event(),onMessage:event(),getURL:p=>p},notifications:{async create(){}},tabs:{onUpdated:event()},windows:{}};
 const context=vm.createContext({console,URL,AbortSignal,Date,setTimeout,clearTimeout,chrome,fetch:async()=>({ok:true,json:async()=>({ok:true})})});
 context.importScripts=(...files)=>{for(const file of files)vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension',file),'utf8'),context);};
 vm.runInContext(fs.readFileSync(path.join(__dirname,"../extension/background.js"),"utf8"),context);
 vm.runInContext("delay = async () => {}",context);
 return {state,context,jobs};
}

test("Falha temporária ao importar preserva a busca na fila, inclusive ao rodar agora",async()=>{
 for(const force of [false,true]) {
  const f=backgroundFixture();f.context.runAutoBrowseJob=async()=>({ok:false,error:"Desktop offline",retryable:true,capture_count:3});
  await f.context.processAutoBrowseTick(null,{force});
  assert.equal(f.state.autoBrowseQueue.length,2);
  assert.equal(f.state.autoBrowseQueue.find(j=>j.id==='1').attempts,1);
 }
});

test("Cancelar preserva também a busca que estava em andamento",async()=>{
 const f=backgroundFixture();
 f.context.runAutoBrowseJob=async()=>{vm.runInContext("autoBrowseCancelRequested = true",f.context);throw Error("Aba fechada pelo cancelamento");};
 const result=await f.context.processAutoBrowseTick(null,{force:true});
 assert.equal(result.cancelled,true);assert.equal(f.state.autoBrowseQueue.length,2);
 assert.equal(f.state.lastAutoBrowseError,null);
});

test("Desligar Auto-Browse durante uma busca não restaura a fila descartada",async()=>{
 const f=backgroundFixture();
 f.context.runAutoBrowseJob=async()=>{f.state.autoBrowseEnabled=false;f.state.autoBrowseQueue=[];return {ok:true,capture_count:2,imported:2};};
 await f.context.processAutoBrowseTick(null,{force:true});
 assert.equal(f.state.autoBrowseQueue.length,0);
});

test("Busca confirmada é removida da fila e deixa as próximas disponíveis",async()=>{
 const f=backgroundFixture();f.context.runAutoBrowseJob=async()=>({ok:true,capture_count:2,imported:2});
 await f.context.processAutoBrowseTick();assert.equal(f.state.autoBrowseQueue.length,1);
 assert.equal(f.state.autoBrowseQueue[0].id,'2');
});

test("Falha parcial de importação permanece visível e permite nova tentativa",async()=>{
 const f=backgroundFixture();
 f.context.fetch=async()=>({ok:true,json:async()=>({imported:2,updated:0,failed:1})});
 const result=await f.context.importAutoCapture({items:[{url:'https://www.ebay.com/itm/123456789012'}],source_url:'https://www.ebay.com/sch/i.html'},{});
 assert.equal(result.ok,false);assert.equal(result.retryable,true);assert.equal(result.result.imported,2);
 assert.match(f.state.lastAutoCaptureError,/1 anúncio/);
});
