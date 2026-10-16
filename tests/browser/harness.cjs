"use strict";
const http=require("node:http"),fs=require("node:fs"),path=require("node:path");
const {PNG}=require("pngjs");
const image=new PNG({width:16,height:16});image.data.fill(255);
const photo=PNG.sync.write(image);
const platforms=[
 {key:"olx",name:"OLX",location:"https://www.olx.com.br/brasil?q=handycam",url:"https://www.olx.com.br/d/anuncio/sony-handycam-dcr-sr47-1234567890",title:"Sony Handycam DCR SR47",price:"R$ 1.299,90",expected:1299.9},
 {key:"enjoei",name:"Enjoei",location:"https://www.enjoei.com.br/s?term=camisa",url:"https://www.enjoei.com.br/p/camisa-vintage-12345678",title:"Camisa vintage tribal",price:"R$ 89,90",expected:89.9},
 {key:"facebook",name:"Facebook Marketplace",location:"https://www.facebook.com/marketplace/",url:"https://www.facebook.com/marketplace/item/123456789012345/",title:"Sony Handycam NightShot HDD",price:"R$ 350",expected:350},
 {key:"ebay",name:"eBay",location:"https://www.ebay.com/sch/i.html",url:"https://www.ebay.com/itm/123456789012",title:"Vintage Sony camcorder HDD",price:"US$ 1,299.99",expected:1299.99},
 {key:"depop",name:"Depop",location:"https://www.depop.com/search/?q=shirt",url:"https://www.depop.com/products/test-vintage-shirt/",title:"Vintage graphic shirt",price:"£ 45.50",expected:45.5},
 {key:"ml",name:"Mercado Livre",location:"https://www.mercadolivre.com.br/cameras",url:"https://produto.mercadolivre.com.br/MLB-1234567890-camera-_JM",title:"Filmadora Sony Handycam HDD",price:"R$ 799,00",expected:799},
];
const escape=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname==='/collector.js'){res.setHeader('content-type','text/javascript');return res.end(fs.readFileSync(path.join(__dirname,'../../extension/collector.js')));}
 if(u.pathname==='/photo.png'){res.setHeader('content-type','image/png');return res.end(photo);}
 res.setHeader('content-type','text/html; charset=utf-8');
 if(u.pathname==='/fixture'){
  const p=platforms.find(p=>p.key===u.searchParams.get('platform'));
  if(!p){res.statusCode=404;return res.end('Unknown fixture');}
  const card=`<article class="c-product-card" data-testid="l-card"><a href="${escape(p.url)}"><img src="/photo.png" alt="${escape(p.title)}"><h3>${escape(p.title)}</h3><span>${escape(p.price)}</span></a></article>`;
  return res.end(`<!doctype html><meta charset="utf-8"><style>article{display:inline-block;width:260px;padding:10px}img{width:100px;height:80px}</style>${card}${card}<script>(async()=>{
   const fixture=${JSON.stringify(p)};
   const chrome={runtime:{onMessage:{addListener(){}},sendMessage:async()=>({ok:true})},storage:{local:{get:async()=>({autoCaptureEnabled:false})},onChanged:{addListener(){}}}};
   const code=await(await fetch('/collector.js')).text();
   new Function('location','chrome',code)({href:fixture.location,hostname:new URL(fixture.location).hostname},chrome);
   await Promise.all([...document.images].map(img=>img.decode().catch(()=>{})));
   const capture=window.__radarCollectVisibleListings(100),item=capture.items[0];
   const checks={oneDeduplicatedItem:capture.items.length===1,title:item?.title===fixture.title,price:item?.current_price===fixture.expected,url:item?.url===fixture.url,image:item?.image_url===new URL('/photo.png',location.href).href,platform:capture.platform===fixture.name};
   parent.postMessage({type:'radar-fixture-result',platform:fixture.name,checks,item},location.origin);
  })().catch(error=>parent.postMessage({type:'radar-fixture-result',platform:${JSON.stringify(p.name)},error:error.message},location.origin));</script>`);
 }
 res.end(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Radar — validação do coletor no Chromium</title><style>body{font:16px system-ui;background:#111923;color:#eef5ff;margin:30px}h1{font-size:26px}li{padding:10px;border-bottom:1px solid #405164}.ok{color:#72edb8}.fail{color:#ff998e}iframe{width:600px;height:210px;border:1px solid #526277;background:white}details{margin:12px 0}pre{white-space:pre-wrap;font-size:12px}</style><h1>Validação do coletor no Chromium</h1><p>Cards de teste locais com DOM real. Nenhum anúncio enviado ao catálogo.</p><h2 id="status">Aguardando 6 plataformas…</h2><ul id="results"></ul><details open><summary>Ver os cards utilizados</summary>${platforms.map(p=>`<iframe title="${p.name}" src="/fixture?platform=${p.key}"></iframe>`).join('')}</details><script>
 const received=new Map();window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.data?.type!=='radar-fixture-result')return;
  received.set(event.data.platform,event.data);const list=document.querySelector('#results');list.replaceChildren();let passed=0;
  for(const result of received.values()){const good=!result.error&&Object.values(result.checks).every(Boolean);if(good)passed++;const li=document.createElement('li');li.className=good?'ok':'fail';li.textContent=(good?'PASSOU — ':'FALHOU — ')+result.platform+' • '+(result.error||Object.keys(result.checks).filter(k=>!result.checks[k]).join(', ')||'título, preço, foto, link e duplicata');list.append(li);}
  document.querySelector('#status').textContent=received.size===6?passed+'/6 plataformas passaram':received.size+'/6 recebidas';
 });</script></html>`);
});
server.listen(3179,'127.0.0.1',()=>console.log('Collector browser harness: http://127.0.0.1:3179'));
