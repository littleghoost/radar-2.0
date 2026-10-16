"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const sqlite3=require("sqlite3");
const crypto=require("node:crypto");
const {registerMobileRelay,sanitizeSnapshot}=require("../server/mobileRelay");
const {paginateMobileListings,isSnapshotId}=require("../server/services/mobileSnapshotPages");

test("Paginação preserva 444, 1201 e até 10000 anúncios sem duplicação",()=>{
 for (const count of [444,1000,1001,1201,10000]) {
  const listings=Array.from({length:count},(_,i)=>({id:i+1,title:"Peça "+i}));
  const result=paginateMobileListings(listings);
  assert.equal(result.paged,count>1000);
  assert.equal(result.pages.flat().length,count);
  assert.equal(new Set(result.pages.flat().map(x=>x.id)).size,count);
  assert.equal(result.truncated,false);
  if(count>1000)assert.ok(result.pages.every(x=>x.length<=200));
 }
 assert.equal(paginateMobileListings(Array(10100).fill({id:1})).truncated,true);
 assert.equal(isSnapshotId("../pasta"),false);
 assert.equal(isSnapshotId(crypto.randomUUID()),true);
});

test("Relay publica páginas apenas depois do upload completo e exige autenticação",async t=>{
 const db=new sqlite3.Database(":memory:");
 const app=express();app.use(express.json({limit:"2mb"}));registerMobileRelay(app,db);
 const server=await new Promise(resolve=>{
  const srv=app.listen(0,"127.0.0.1",()=>resolve(srv));
 });
 t.after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  await new Promise(resolve=>db.close(resolve));
 });
 const base="http://127.0.0.1:"+server.address().port;
 async function call(route,{method="GET",body,headers={}}={}){
  const res=await fetch(base+route,{method,headers:{"content-type":"application/json",...headers},
   body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,data:await res.json()};
 }
 const reg=await call("/bridge/mobile/desktop/register",{method:"POST",body:{label:"Teste local"}});
 assert.equal(reg.status,201,JSON.stringify(reg.data));
 const desk={"x-radar-desktop-id":reg.data.desktop_id,"x-radar-desktop-key":reg.data.desktop_key};
 const pair=await call("/bridge/mobile/desktop/pairing",{method:"POST",body:{},headers:desk});
 assert.equal(pair.status,201);
 const claim=await call("/bridge/mobile/pair/"+pair.data.pairing_id+"/claim",{
  method:"POST",body:{pairing_secret:pair.data.pairing_secret,label:"Teste celular"}});
 assert.equal(claim.status,201);
 const mobile={"x-radar-mobile-id":claim.data.mobile_id,"x-radar-mobile-key":claim.data.mobile_key};
 const initial=sanitizeSnapshot({listings:[{id:1,title:"Primeiro anúncio"}]});
 assert.equal((await call("/bridge/mobile/desktop/snapshot",{method:"PUT",headers:desk,body:initial})).status,200);
 const all=Array.from({length:1201},(_,i)=>({id:i+1,radar_id:10,url:"https://example.org/list/"+(i+1),title:"Item "+(i+1)}));
 const split=paginateMobileListings(all);
 const id=crypto.randomUUID();
 const commit={summary:{listing_count:all.length},listings:split.pages[0],snapshot_id:id,page_count:split.pages.length};
 assert.equal((await call("/bridge/mobile/desktop/snapshot",{method:"PUT",headers:desk,body:commit})).status,409);
 assert.equal((await call("/bridge/mobile/device/snapshot",{headers:mobile})).data.listings.length,1);
 assert.equal((await call("/bridge/mobile/desktop/snapshot/page",{method:"PUT",body:{snapshot_id:id,page_index:1,page_count:split.pages.length,listings:split.pages[1]}})).status,401);
 for(let i=1;i<split.pages.length;i++){
  const result=await call("/bridge/mobile/desktop/snapshot/page",{
   method:"PUT",headers:desk,body:{snapshot_id:id,page_index:i,page_count:split.pages.length,listings:split.pages[i]}
  });
  assert.equal(result.status,200,JSON.stringify(result.data));
 }
 const saved=await call("/bridge/mobile/desktop/snapshot",{method:"PUT",headers:desk,body:commit});
 assert.equal(saved.status,200,JSON.stringify(saved.data));
 const received=await call("/bridge/mobile/device/snapshot",{headers:mobile});
 assert.equal(received.data.snapshot_id,id);
 assert.equal(received.data.page_count,split.pages.length);
 const reconstructed=[...received.data.listings];
 for(let i=1;i<split.pages.length;i++){
  const page=await call("/bridge/mobile/device/snapshot/page/"+i+"?snapshot_id="+id,{headers:mobile});
  assert.equal(page.status,200,JSON.stringify(page.data));
  reconstructed.push(...page.data.listings);
 }
 assert.equal(reconstructed.length,1201);
 assert.equal(new Set(reconstructed.map(x=>x.id)).size,1201);
 assert.equal((await call("/bridge/mobile/device/snapshot/page/1?snapshot_id="+crypto.randomUUID(),{headers:mobile})).status,409);
 assert.equal((await call("/bridge/mobile/device/snapshot/page/1?snapshot_id="+id)).status,401);
});
