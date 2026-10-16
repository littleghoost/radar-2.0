"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sites=require('../extension/marketplaces');

function fixture(initial={}) {
  const state={autoBrowseEnabled:true,autoCaptureEnabled:true,autoBrowseQueue:[],...initial};
  const allowed=new Set(['https://www.mercari.com/*','https://shop.example.org/*']);
  const tabs=new Map(),created=[],closed=[],posts=[],scripts=[];
  let capture={source_url:'https://www.mercari.com/search/?keyword=sony',items:[],diagnostics:{requiresUserAction:'login_required'}};
  const event={addListener(){},removeListener(){}};
  const chrome={runtime:{id:'test-extension',getURL:p=>p,onInstalled:event,onStartup:event,onMessage:event},
    storage:{local:{async get(keys){return Array.isArray(keys)?Object.fromEntries(keys.map(k=>[k,state[k]])):{...keys,...state};},async set(values){Object.assign(state,values);}}},
    permissions:{async contains({origins}){return origins.every(o=>allowed.has(o));},onRemoved:event},
    scripting:{async getRegisteredContentScripts(){return [...scripts];},async unregisterContentScripts({ids}){for(let i=scripts.length-1;i>=0;i--)if(ids.includes(scripts[i].id))scripts.splice(i,1);},async registerContentScripts(rows){scripts.push(...rows);}},
    alarms:{async get(){return {};},create(){},onAlarm:event},notifications:{async create(){}},
    tabs:{onUpdated:event,async get(id){if(!tabs.has(id))throw Error('closed');return tabs.get(id);},async query({windowId}){return [...tabs.values()].filter(t=>t.windowId===windowId);},async sendMessage(){return {capture};},async remove(id){closed.push(id);tabs.delete(id);}},
    windows:{async create({url}){const id=created.length+1;created.push(url);tabs.set(id,{id,windowId:id,status:'complete',url});return {id};},async remove(id){closed.push(id);tabs.delete(id);}}};
  const context=vm.createContext({console,URL,URLSearchParams,Date,Math,AbortSignal,setTimeout,clearTimeout,chrome,
    fetch:async(url,options={})=>{
      if(options.body)posts.push(JSON.parse(options.body));
      return {ok:true,json:async()=>String(url).endsWith('/api/radars')?[]:{ok:true,imported:1}};
    }});
  context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension',file),'utf8'),context));
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),context);
  vm.runInContext('delay = async()=>{}',context);
  return {context,state,allowed,created,closed,posts,scripts,setCapture(value){capture=value;}};
}

test('Busca salva preserva filtros e radar, sem aceitar URL de autenticação ou rede local',async()=>{
  const f=fixture();
  const saved=await f.context.saveBrowserSearch({url:'https://shop.example.org/search?q=sony&condition=used&utm_source=radar',radar_id:7,interval_minutes:10});
  assert.equal(saved.url,'https://shop.example.org/search?q=sony&condition=used');
  assert.equal(saved.radar_id,'7');assert.equal(saved.interval_minutes,60);
  const jobs=await f.context.dueSavedBrowserJobs([{id:7}]);
  assert.equal(jobs.length,1);assert.equal(jobs[0].url,saved.url);assert.equal(jobs[0].radar_id,'7');
  assert.equal((await f.context.dueSavedBrowserJobs([{id:7}])).length,0);
  for(const url of ['http://shop.example.org/','https://127.0.0.1/','https://shop.example.org/login','https://shop.example.org/search?access_token=secret']){
    await assert.rejects(()=>f.context.saveBrowserSearch({url}));
  }
  await assert.rejects(()=>f.context.saveBrowserSearch({url:'https://unapproved.example.org/search'}));
});

test('Registro persistente injeta somente nos sites escolhidos e ainda autorizados',async()=>{
  const f=fixture({browserSites:['https://shop.example.org','https://unapproved.example.org']});
  await f.context.registerBrowserSites();
  assert.equal(f.scripts.length,1);assert.deepEqual([...f.scripts[0].matches],['https://shop.example.org/*']);
  f.allowed.clear();await f.context.registerBrowserSites();assert.equal(f.scripts.length,0);
});

test('Login mantém a busca e a janela; retomar usa a mesma sessão e conclui a importação',async()=>{
  const job={id:'mercari-1',source:'mercari',radar_id:7,source_query:'sony',url:'https://www.mercari.com/search/?keyword=sony'};
  const f=fixture({autoBrowseQueue:[job]});
  const first=await f.context.processAutoBrowseTick();
  assert.equal(first.result.requires_user_action,true);assert.equal(f.state.autoBrowseQueue.length,1);
  assert.equal(f.created.length,1);assert.equal(f.closed.length,0);
  assert.equal(f.state.browserSourcePauses.mercari.reason,'login_required');
  f.setCapture({version:10,source_url:job.url,items:[{title:'Sony Handycam',url:'https://www.mercari.com/us/item/m123456789/'}],diagnostics:{}});
  await f.context.resumeBrowserSource('mercari');
  assert.equal(f.created.length,1);assert.equal(f.closed.length,1);assert.equal(f.state.autoBrowseQueue.length,0);
  assert.equal(f.posts[0].radar_id,7);assert.equal(f.posts[0].auto_assign,false);
});

test('Fonte pendente não abre outra janela nem impede outra fonte da fila',async()=>{
  const f=fixture({browserSourcePauses:{mercari:{reason:'verification_required'}},autoBrowseQueue:[
    {id:'1',source:'mercari',source_query:'sony',url:'https://www.mercari.com/search/?keyword=sony'},
    {id:'2',source:'olx',source_query:'sony',url:'https://www.olx.com.br/brasil?q=sony'}]});
  const sources=[];f.context.runAutoBrowseJob=async job=>{sources.push(job.source);return {ok:true,capture_count:1};};
  await f.context.processAutoBrowseTick();
  assert.deepEqual(sources,['olx']);assert.equal(f.state.autoBrowseQueue.length,1);
  await f.context.processAutoBrowseTick();assert.equal(sources.length,1);
});

test('Domínios e perfis usam limites de hostname, incluindo Mercari japonês',()=>{
  assert.equal(sites.profile('jp.mercari.com').name,'Mercari');
  assert.equal(sites.profile('mercari.com.example.org').generic,true);
  assert.equal(sites.originPattern('https://shop.example.org/search?q=a'),'https://shop.example.org/*');
});
