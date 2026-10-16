"use strict";
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const state = {browserSites:[],browserSearches:[],browserSourcePauses:{}};
  const granted = new Set();
  let registered = [];
  const operations = [];
  const chrome = {
    storage:{local:{
      async get(keys) {return {...keys,...state};},
      async set(update) {Object.assign(state,update);}
    }},
    permissions:{
      async contains({origins}) {return origins.every(origin=>granted.has(origin));},
      onRemoved:{addListener(){}}
    },
    scripting:{
      async getRegisteredContentScripts() {return registered;},
      async unregisterContentScripts({ids}) {
        operations.push(['unregister',ids]);
        registered=registered.filter(s=>!ids.includes(s.id));
      },
      async registerContentScripts(scripts) {
        operations.push(['register',scripts.map(s=>s.id)]);
        registered=[...registered,...scripts];
      }
    }
  };
  const context=vm.createContext({URL,Date,Math,chrome,console});
  for(const script of ['marketplaces.js','browserSearches.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension',script),'utf8'),context,{filename:script});
  }
  return {state,granted,operations,context,registered:()=>registered};
}

test('Perfis distinguem marketplaces de domínios parecidos',()=>{
  const {context}=fixture();
  assert.equal(context.RadarSites.profile('jp.mercari.com').key,'mercari');
  assert.equal(context.RadarSites.profile('www.vinted.fr').key,'vinted');
  assert.equal(context.RadarSites.profile('www.grailed.com').key,'grailed');
  assert.equal(context.RadarSites.profile('fake-mercari.com').generic,true);
});

test('Busca salva exige HTTPS público e rejeita tokens e páginas privadas',()=>{
  const {context}=fixture();
  const safe=context.RadarSites.safeSearchUrl;
  assert.equal(safe('https://jp.mercari.com/search?keyword=handycam&utm_source=test'),'https://jp.mercari.com/search?keyword=handycam');
  for(const unsafe of [
    'http://www.mercari.com/search','https://localhost/search',
    'https://127.0.0.1/search','https://foo.com/login',
    'https://foo.com/search?token=secret',
    'https://user:pass@foo.com/search',
    'javascript:alert(1)',
  ]) assert.equal(safe(unsafe),null,unsafe);
});

test('Captura dinâmica só registra sites autorizados e remove os desligados',async()=>{
  const f=fixture();
  const url='https://jp.mercari.com/search?keyword=sony';
  f.state.browserSites=[url];
  await f.context.registerBrowserSites();
  assert.equal(f.registered().length,0);
  f.granted.add('https://jp.mercari.com/*');
  await f.context.registerBrowserSites();
  assert.equal(f.registered().length,1);
  assert.equal(f.registered()[0].matches[0],'https://jp.mercari.com/*');
  assert.deepEqual(Array.from(f.registered()[0].js),['marketplaces.js','collector.js']);
  f.state.browserSites=[];
  await f.context.registerBrowserSites();
  assert.equal(f.registered().length,0);
  assert.ok(f.operations.some(([name])=>name==='unregister'));
});

test('Salvar busca preserva radar e evita duplicata; vencimento respeita intervalo',async()=>{
  const f=fixture();
  const url='https://jp.mercari.com/search?keyword=sony';
  f.granted.add('https://jp.mercari.com/*');
  const a=await f.context.saveBrowserSearch({url,radar_id:'2',label:'Handycam',interval_minutes:'60'});
  const b=await f.context.saveBrowserSearch({url,radar_id:'2',label:'Handycam',interval_minutes:240});
  assert.equal(a.id,b.id);
  assert.equal(f.state.browserSearches.length,1);
  const first=await f.context.dueSavedBrowserJobs([{id:2}]);
  assert.equal(first.length,1);
  assert.equal(first[0].source,'mercari');
  assert.equal(first[0].radar_id,'2');
  assert.equal((await f.context.dueSavedBrowserJobs([{id:2}])).length,0);
  assert.equal((await f.context.dueSavedBrowserJobs([{id:2}],true)).length,1);
  assert.equal((await f.context.dueSavedBrowserJobs([{id:99}])).length,0);
});

test('Não salva uma busca sem permissão do site',async()=>{
  const f=fixture();
  await assert.rejects(()=>f.context.saveBrowserSearch({url:'https://www.grailed.com/shop'}),/Ative a coleta/);
});

test('Sites genéricos não confundem páginas de categoria com anúncios individuais',()=>{
  const f=fixture();
  const collection={querySelectorAll:()=>[],addEventListener(){},body:{innerText:''},documentElement:{}};
  const context=vm.createContext({
    URL,Date,console,chrome:{
      runtime:{onMessage:{addListener(){}}},
      storage:{onChanged:{addListener(){}},local:{async get(){return {autoCaptureEnabled:false};}}}
    },
    location:{hostname:'www.loja-exemplo.com',href:'https://www.loja-exemplo.com/search?q=grail'},
    document:collection,
    MutationObserver:class {observe(){}},
    setTimeout(){return 1;},clearTimeout(){},addEventListener(){}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/marketplaces.js'),'utf8'),context);
  const code=fs.readFileSync(path.join(__dirname,'../extension/collector.js'),'utf8')
    .replace('  globalThis.__radarCollectVisibleListings = collectVisibleListings;',
      '  globalThis.__testListingUrl = looksLikeListingUrl;\n  globalThis.__radarCollectVisibleListings = collectVisibleListings;');
  vm.runInContext(code,context);
  for(const pathPart of ['/search?q=camisa','/collections/jeans','/categoria/roupas','/blog/review']) {
    assert.equal(context.__testListingUrl('https://www.loja-exemplo.com'+pathPart,'www.loja-exemplo.com'),false,pathPart);
  }
  for(const pathPart of ['/products/vintage-shirt','/item/12345','/camisa-tribal-12345678']) {
    assert.equal(context.__testListingUrl('https://www.loja-exemplo.com'+pathPart,'www.loja-exemplo.com'),true,pathPart);
  }
});

test('Página real com bloqueio de segurança indica ação do usuário, sem inventar anúncios',()=>{
  const document={body:{innerText:'www.grailed.com Performing security verification. This website uses a security service to protect against malicious bots.'},
    documentElement:{},querySelectorAll(){return []},addEventListener(){}};
  const ctx=vm.createContext({URL,Date,console,location:{href:'https://www.grailed.com/shop?query=jnco',hostname:'www.grailed.com'},document,
    MutationObserver:class{observe(){}},setTimeout(){return 1},clearTimeout(){},addEventListener(){},
    chrome:{runtime:{onMessage:{addListener(){}}},storage:{local:{async get(){return {autoCaptureEnabled:false}}},onChanged:{addListener(){}}}}});
  for(const name of ['marketplaces.js','collector.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension',name),'utf8'),ctx);
  const capture=ctx.__radarCollectVisibleListings(100);
  assert.equal(capture.items.length,0);
  assert.equal(capture.diagnostics.requiresUserAction,'verification_required');
});

test('Novos perfis brasileiros reconhecem sites legítimos',()=>{
  const {context}=fixture();
  for(const [hostname,key] of [
    ['shopee.com.br','shopee'],
    ['www.repassa.com.br','repassa'],
    ['www.ebrecho.com.br','ebrecho'],
  ]) assert.equal(context.RadarSites.profile(hostname).key,key);
  assert.equal(context.RadarSites.profile('fake-shopee.com.br').generic,true);
});

test('Shopee e Repassa aceitam somente links individuais, não categorias',()=>{
  const document={body:{innerText:''},documentElement:{},querySelectorAll(){return []},addEventListener(){}};
  const ctx=vm.createContext({URL,Date,console,
    location:{href:'https://shopee.com.br/search?keyword=brecho',hostname:'shopee.com.br'},
    document, MutationObserver:class{observe(){}},setTimeout(){},clearTimeout(){},addEventListener(){},
    chrome:{runtime:{onMessage:{addListener(){}}},storage:{onChanged:{addListener(){}},local:{async get(){return {autoCaptureEnabled:false}}}}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/marketplaces.js'),'utf8'),ctx);
  const collector=fs.readFileSync(path.join(__dirname,'../extension/collector.js'),'utf8')
    .replace('  globalThis.__radarCollectVisibleListings = collectVisibleListings;',
      '  globalThis.__testListingUrl = looksLikeListingUrl;\n  globalThis.__testIdentity = listingIdentity;\n  globalThis.__radarCollectVisibleListings = collectVisibleListings;');
  vm.runInContext(collector,ctx);
  const shop='https://shopee.com.br/Calca-vintage-i.928575714.22994509747';
  const second='https://shopee.com.br/product/928575714/22994509747';
  const repassa='https://www.repassa.com.br/produtos/calca-jeans-feminina-azul';
  assert.equal(ctx.__testListingUrl(shop,'Shopee'),true);
  assert.equal(ctx.__testListingUrl(second,'Shopee'),true);
  assert.equal(ctx.__testIdentity(shop,'Shopee'),ctx.__testIdentity(second,'Shopee'));
  assert.equal(ctx.__testListingUrl('https://shopee.com.br/search?keyword=calca','Shopee'),false);
  assert.equal(ctx.__testListingUrl(repassa,'Repassa'),false); // Another site's links blocked on a Shopee page.
  ctx.location.href='https://www.repassa.com.br/prod';ctx.location.hostname='www.repassa.com.br';
  assert.equal(ctx.__testListingUrl(repassa,'Repassa'),true);
  assert.equal(ctx.__testListingUrl('https://www.repassa.com.br/store/product/2080729/cal-a-jeans-tng','Repassa'),true);
  assert.equal(ctx.__testListingUrl('https://www.repassa.com.br/store/sell','Repassa'),false);
  assert.equal(ctx.__testListingUrl('https://www.repassa.com.br/prod','Repassa'),false);
});


test('Shopee: tela de verificação de tráfego suspende a coleta',()=>{
  const document={body:{innerText:''},documentElement:{},querySelectorAll(){return []},addEventListener(){}};
  const ctx=vm.createContext({URL,Date,console,
    location:{href:'https://shopee.com.br/verify/traffic/error?home_url=test',hostname:'shopee.com.br'},
    document,MutationObserver:class{observe(){}},setTimeout(){},clearTimeout(){},addEventListener(){},
    chrome:{runtime:{onMessage:{addListener(){}}},storage:{local:{async get(){return {autoCaptureEnabled:false}}},onChanged:{addListener(){}}}}});
  for(const name of ['marketplaces.js','collector.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension',name),'utf8'),ctx);
  const capture=ctx.__radarCollectVisibleListings(100);
  assert.equal(capture.items.length,0);
  assert.equal(capture.diagnostics.requiresUserAction,'verification_required');
});
