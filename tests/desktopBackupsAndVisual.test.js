"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path"),fs=require("node:fs/promises");
const os=require("node:os");
const sqlite3=require("sqlite3");
const {createDesktopBackupService}=require("../server/services/desktopBackups");
const {extractVisualFeatures,visualSimilarity,hybridScore,passesVisualThreshold}=require("../server/services/visualSimilarity");
const {evaluateRadarCriteria,blendCriteriaScore}=require("../server/services/radarCriteria");
const {getAssistedSourceStatuses}=require("../server/services/sources/assisted");
const {PNG}=require("pngjs");

test("Backup SQLite preserva banco em uso e não sobrescreve a cópia do dia",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"radar-backup-"));
 const db=new sqlite3.Database(path.join(root,"main.db"));
 t.after(async()=>{
  await new Promise(resolve=>db.close(()=>resolve()));
  await fs.rm(root,{recursive:true,force:true});
 });
 await new Promise((resolve,reject)=>db.run("CREATE TABLE registros (id INTEGER PRIMARY KEY, nome TEXT)",err=>err?reject(err):resolve()));
 await new Promise((resolve,reject)=>db.run("INSERT INTO registros(nome) VALUES ('teste de recuperação')",err=>err?reject(err):resolve()));
 const service=createDesktopBackupService({db,dataDir:root,now:()=>new Date("2026-10-16T12:00:00Z")});
 const result=await service.run();
 assert.equal(result.ok,true);
 const reader=new sqlite3.Database(result.target,sqlite3.OPEN_READONLY);
 const row=await new Promise((resolve,reject)=>reader.get("SELECT nome FROM registros LIMIT 1",(e,r)=>e?reject(e):resolve(r)));
 assert.equal(row.nome,"teste de recuperação");
 await new Promise(resolve=>reader.close(resolve));
 const again=await service.run();
 assert.equal(again.skipped,true);
 assert.equal((await fs.readdir(service.backupDir)).filter(f=>f.endsWith(".db")).length,1);
});
function png(color){
 const image=new PNG({width:12,height:12});
 for(let i=0;i<image.data.length;i+=4) {
  image.data[i]=color[0];image.data[i+1]=color[1];image.data[i+2]=color[2];image.data[i+3]=255;
 }
 return PNG.sync.write(image);
}
test("Camada visual diferencia referências e a classificação penaliza acessórios",async()=>{
 const imageA=await extractVisualFeatures(png([30,50,110]));
 const imageB=await extractVisualFeatures(png([30,50,110]));
 const imageC=await extractVisualFeatures(png([210,30,30]));
 assert.ok(visualSimilarity(imageA,imageB)>0.99);
 assert.ok(visualSimilarity(imageA,imageC)<visualSimilarity(imageA,imageB));
 const radar={category:"cameras",query:"sony dcr sr hdd nightshot",max_price:350,
  required_terms_json:'["sony"]',exclude_terms_json:'["carregador"]'};
 const accessory=evaluateRadarCriteria(radar,{title:"Carregador para Sony Handycam DCR-SR47",current_price:39,currency:"BRL"});
 assert.equal(accessory.rejected,true);
 assert.equal(blendCriteriaScore(92,accessory,radar),0);
 const complete=evaluateRadarCriteria(radar,{title:"Filmadora Sony DCR-SR47 HDD com NightShot",current_price:299,currency:"BRL"});
 assert.equal(complete.rejected,false);
 assert.ok(blendCriteriaScore(70,complete,radar)>0);
 assert.ok(hybridScore({visual:0.9,semantic:0.8,query:radar.query,title:"Sony DCR SR HDD",price:299,maxPrice:350})>0);
});
test("Fontes sem APIs públicas não são anunciadas como busca automática",()=>{
 const sources=getAssistedSourceStatuses();
 for(const key of ["enjoei","facebook","vinted"]) {
  assert.equal(sources[key].mode,"browser_bridge");
  assert.equal(sources[key].automatic_api,false);
  assert.equal(sources[key].assisted_import,true);
 }
});

test("Peso de regras zero preserva score base sem liberar exclusões",()=>{
 const radar={query:"camisa vintage",criteria_weight:0,priority_terms_json:'["vintage"]',exclude_terms_json:'["defeito"]'};
 const normal=evaluateRadarCriteria(radar,{title:"Camisa vintage",current_price:80});
 assert.equal(blendCriteriaScore(42,normal,radar),42);
 const excluded=evaluateRadarCriteria(radar,{title:"Camisa vintage com defeito",current_price:80});
 assert.equal(blendCriteriaScore(42,excluded,radar),0);
});

test("Limite visual distingue imagem indisponível de comparação negativa",()=>{
 assert.equal(passesVisualThreshold({visual_score:null,semantic_score:null},0.45),true);
 assert.equal(passesVisualThreshold({visual_score:0,semantic_score:null},0.45),false);
 assert.equal(passesVisualThreshold({visual_score:20,semantic_score:80},0.45),true);
});
