"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function collectorFixture({offline = false, reply = {ok:true}, platform = 'ebay'} = {}) {
  let now = 100000, nextTimer = 0, observer, observed;
  const timers = new Map(), messages = [], listeners = {}, storageListeners = [];
  const item = {title:"Sony Handycam DCR SR47",price:"R$ 299,90",image:"https://i.ebayimg.com/camera.jpg"};
  const img = {get currentSrc(){return item.image;},get src(){return item.image;},get alt(){return item.title;},getAttribute(name){return item[name] || null;}};
  const heading = {get innerText(){return item.title;}};
  const card = {get innerText(){return item.title+" "+item.price;},outerHTML:'<article data-url="/p/camisa-vintage-12345678"></article>',querySelectorAll(){return [];},querySelector(selector){return selector==='img'?img:heading;},getBoundingClientRect(){return {width:200,height:200};}};
  const anchor = {href:"https://www.ebay.com/itm/123456789012",getAttribute(){return this.href;},closest(){return card;}};
  const document = {visibilityState:"visible",body:{innerText:"Sony Handycam R$ 299,90"},documentElement:{},querySelectorAll(selector){if(platform==='enjoei'&&selector.includes('.c-product-card'))return [card];return selector==='a[href]'?(platform==='enjoei'?[]:[anchor]):selector==='img'?[img]:[];},addEventListener(name,fn){listeners[name]=fn;}};
  const state = {autoCaptureEnabled:true};
  const context = vm.createContext({
    URL,console,Date:class extends Date {static now(){return now;}},location:{hostname:platform==='enjoei'?'www.enjoei.com.br':'www.ebay.com',href:platform==='enjoei'?'https://www.enjoei.com.br/s?term=camisa':'https://www.ebay.com/sch/i.html'},document,
    MutationObserver:class {constructor(fn){observer=fn;}observe(_node,options){observed=options;}},
    addEventListener(name,fn){listeners[name]=fn;},
    setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{at:now+ms,fn});return id;},clearTimeout(id){timers.delete(id);},
    chrome:{storage:{local:{async get(){return state;}},onChanged:{addListener(fn){storageListeners.push(fn);}}},runtime:{onMessage:{addListener(){}},async sendMessage(message){messages.push(message);if(offline)throw Error("offline");return reply;}}},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../extension/collector.js"),"utf8"),context);
  async function advance(ms) {
    const end=now+ms;
    for(let steps=0;steps<100;steps++) {
      const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!due)break;
      now=due[1].at;timers.delete(due[0]);due[1].fn();
      for(let i=0;i<10;i++)await Promise.resolve();
    }
    now=end;
  }
  return {item,img,messages,state,advance,context,setOffline(value){offline=value;},mutate(type){if(type==='childList'||observed?.[type==='attributes'?'attributes':'characterData'])observer([{type}]);},scroll(){listeners.scroll();},visibility(value){document.visibilityState=value;listeners.visibilitychange();},toggle(value){state.autoCaptureEnabled=value;for(const fn of storageListeners)fn({autoCaptureEnabled:{newValue:value}},'local');}};
}

test("Auto-Capture envia mudança de título e foto mesmo com URL e preço iguais",async()=>{
  const f=collectorFixture();await f.advance(2500);assert.equal(f.messages.length,1);
  await f.advance(16000);f.item.title="Sony Handycam DCR SR47 HDD";f.item.image="https://i.ebayimg.com/camera-new.jpg";
  f.scroll();await f.advance(5000);
  assert.equal(f.messages.length,2);
  assert.equal(f.messages[1].capture.items[0].image_url,f.item.image);
});

test("Auto-Capture reconhece atualização de atributos sem precisar de scroll",async()=>{
  const f=collectorFixture();await f.advance(20000);f.item.image="https://i.ebayimg.com/changed.jpg";
  f.mutate('attributes');await f.advance(6000);assert.equal(f.messages.length,2);
});

test("Captura offline tenta novamente em página estática e para após confirmação",async()=>{
  const f=collectorFixture({offline:true});await f.advance(2500);assert.equal(f.messages.length,1);
  f.setOffline(false);await f.advance(30000);assert.equal(f.messages.length,2);
  await f.advance(60000);assert.equal(f.messages.length,2);
});

test("Ativar Auto-Capture numa página estática inicia captura e respeita aba oculta",async()=>{
  const f=collectorFixture();f.toggle(false);await f.advance(30000);assert.equal(f.messages.length,0);
  f.visibility('hidden');f.toggle(true);await f.advance(30000);assert.equal(f.messages.length,0);
  f.visibility('visible');await f.advance(5000);assert.equal(f.messages.length,1);
});

test("Ativar Auto-Capture inicia captura sem navegação nem alteração da página",async()=>{
  const f=collectorFixture();f.toggle(false);await f.advance(30000);assert.equal(f.messages.length,0);
  f.toggle(true);await f.advance(5000);assert.equal(f.messages.length,1);
});

test("Mudança de preço dentro do intervalo é enviada depois de quinze segundos",async()=>{
  const f=collectorFixture();await f.advance(2500);f.item.price="R$ 249,90";f.mutate('characterData');
  await f.advance(6000);assert.equal(f.messages.length,1);
  await f.advance(12000);assert.equal(f.messages.length,2);
  assert.equal(f.messages[1].capture.items[0].current_price,249.9);
});

test("Imagem lazy-loaded usa a foto real quando src ainda é placeholder",()=>{
  const f=collectorFixture();f.item.image='data:image/gif;base64,R0lGODlhAQAB';f.item['data-src']='https://i.ebayimg.com/real-camera.jpg';
  const capture=f.context.__radarCollectVisibleListings(100);
  assert.equal(capture.items[0].image_url,f.item['data-src']);
});

test("Captura inválida não gera tentativas repetidas em página estática",async()=>{
 const f=collectorFixture({reply:{ok:false,retryable:false,error:'captura inválida'}});
 await f.advance(120000);assert.equal(f.messages.length,1);
 f.scroll();await f.advance(30000);assert.equal(f.messages.length,1);
});

test("Preço em euro também aceita formato numérico internacional do eBay",()=>{
 const f=collectorFixture();f.item.price='EUR 1,234.56';
 const item=f.context.__radarCollectVisibleListings(100).items[0];
 assert.equal(item.current_price,1234.56);assert.equal(item.currency,'EUR');
});

test("Enjoei reconhece URL embutida com letra s no slug do anúncio",()=>{
 const f=collectorFixture({platform:'enjoei'});f.item.title='Camisa vintage';
 const items=f.context.__radarCollectVisibleListings(100).items;
 assert.equal(items.length,1);assert.equal(items[0].url,'https://www.enjoei.com.br/p/camisa-vintage-12345678');
});
