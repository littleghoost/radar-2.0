let browserPage = null;
let browserCurrentEnabled = false;
async function browserMessage(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || 'A Bridge não respondeu.');
  return result.result;
}
async function loadBrowserSearches() {
  browserPage = await activeTab();
  const {browserSearches=[],browserSourcePauses={},browserSites=[]} = await chrome.storage.local.get({browserSearches:[],browserSourcePauses:{},browserSites:[]});
  let origin;
  try { origin = new URL(browserPage.url).origin; } catch {}
  browserCurrentEnabled = browserSites.includes(origin);
  $('#enableSite').textContent = browserSites.includes(origin) ? 'Desativar coleta neste site' : 'Ativar coleta neste site';
  const list = $('#savedSearches');
  list.replaceChildren();
  for (const search of browserSearches) {
    const row = document.createElement('div');
    const text = document.createElement('span');
    text.textContent = `${search.label} • ${search.interval_minutes/60}h`;
    const open = document.createElement('button'); open.textContent='Abrir';
    open.addEventListener('click',()=>chrome.tabs.create({url:search.url}));
    const remove = document.createElement('button'); remove.textContent='Remover';
    remove.addEventListener('click',async()=>{
      const state = await chrome.storage.local.get({browserSearches:[],autoBrowseQueue:[]});
      await chrome.storage.local.set({browserSearches:state.browserSearches.filter(s=>s.id!==search.id),autoBrowseQueue:state.autoBrowseQueue.filter(j=>j.search_id!==search.id)});
    });
    row.append(text,open,remove); list.append(row);
  }
  const pending = $('#pendingSources'); pending.replaceChildren();
  for (const [source,entry] of Object.entries(browserSourcePauses)) {
    const row=document.createElement('div'),text=document.createElement('span');
    text.textContent=`${source}: ${entry.reason==='permission_required'?'ative a coleta no site':'conclua login ou verificação no site'}`;
    const open=document.createElement('button');open.textContent='Abrir página pendente';
    open.addEventListener('click',async()=>{
      try {
        if (!entry.tab_id) throw Error('Sem aba');
        const tab=await chrome.tabs.update(entry.tab_id,{active:true});
        await chrome.windows.update(tab.windowId,{focused:true,state:'normal'});
      } catch { await chrome.tabs.create({url:entry.url}); }
    });
    const resume=document.createElement('button');resume.textContent='Continuar';
    resume.addEventListener('click',()=>browserAction(()=>browserMessage({type:'radar-resume-source',source})));
    row.append(text,open,resume);pending.append(row);
  }
}
async function browserAction(action) {
  try { await action(); $('#browserMessage').textContent='Salvo. Acompanhe a busca pelo Auto-Browse.'; }
  catch (error) { $('#browserMessage').textContent=error.message; }
}
async function enableCurrentSite() {
  const pattern=RadarSites.originPattern(browserPage?.url);
  if (!pattern) throw Error('Abra uma página HTTPS de busca de produtos.');
  if (!await chrome.permissions.request({origins:[pattern]})) throw Error('Acesso não concedido. A captura manual continua disponível.');
  const {disabledBrowserOrigins=[]}=await chrome.storage.local.get({disabledBrowserOrigins:[]});
  await chrome.storage.local.set({disabledBrowserOrigins:disabledBrowserOrigins.filter(o=>o!==new URL(browserPage.url).origin)});
  const {browserSites=[]}=await chrome.storage.local.get({browserSites:[]});
  const origin=new URL(browserPage.url).origin;
  if (!browserSites.includes(origin)) await chrome.storage.local.set({browserSites:[...browserSites,origin]});
  await browserMessage({type:'radar-register-sites'});
  await chrome.scripting.executeScript({target:{tabId:browserPage.id},files:['marketplaces.js','collector.js']});
}
$('#enableSite').addEventListener('click',()=>browserAction(async()=>{
  // Keep the permission request directly attached to the user's click.
  if (!browserCurrentEnabled) return enableCurrentSite();
  const origin=RadarSites.safeSearchUrl(browserPage?.url) && new URL(browserPage.url).origin;
  const {browserSites=[]}=await chrome.storage.local.get({browserSites:[]});
  const {browserSearches=[],autoBrowseQueue=[]}=await chrome.storage.local.get({browserSearches:[],autoBrowseQueue:[]});
  const removed=new Set(browserSearches.filter(s=>new URL(s.url).origin===origin).map(s=>s.id));
  const {disabledBrowserOrigins=[]}=await chrome.storage.local.get({disabledBrowserOrigins:[]});
  await chrome.storage.local.set({disabledBrowserOrigins:[...new Set([...disabledBrowserOrigins,origin])],browserSites:browserSites.filter(s=>s!==origin),browserSearches:browserSearches.filter(s=>!removed.has(s.id)),autoBrowseQueue:autoBrowseQueue.filter(j=>!removed.has(j.search_id) && new URL(j.url).origin!==origin)});
  await browserMessage({type:'radar-register-sites'});
  await chrome.permissions.remove({origins:[RadarSites.originPattern(origin)]});
}));
$('#saveSearch').addEventListener('click',()=>browserAction(async()=>{
  await browserMessage({type:'radar-save-search',search:{url:browserPage?.url,
    radar_id:$('#radarSelect').value || null,label:$('#savedSearchLabel').value,
    interval_minutes:$('#savedSearchInterval').value}});
}));

function populateBrazilTerms() {
  const category = $('#brazilCategory').value;
  const target = $('#brazilTerm');
  const terms = RadarBrazilPresets.terms[category] || [];
  target.replaceChildren(...terms.map(term => new Option(term, term)));
}
$('#brazilCategory').addEventListener('change', populateBrazilTerms);
populateBrazilTerms();
$('#openBrazilSearch').addEventListener('click', async () => {
  const source = $('#brazilSource').value;
  const query = $('#brazilTerm').value;
  const url = RadarBrazilPresets.buildUrl(source, query);
  const message = $('#brazilSearchStatus');
  if (!url) { message.textContent = 'Selecione uma busca válida.'; return; }
  try {
    await chrome.tabs.create({url});
    message.textContent = 'Busca aberta. Nessa aba, use Analisar página atual e Salvar busca.';
  } catch (error) {
    message.textContent = 'Não consegui abrir a pesquisa: ' + error.message;
  }
});
