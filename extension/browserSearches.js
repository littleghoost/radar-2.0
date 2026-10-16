// Search pages stay in the user's browser profile. Only rendered listing metadata
// goes to Radar; passwords, cookies and marketplace storage are never read.
let browserRegistration = Promise.resolve();
function registerBrowserSites() {
  browserRegistration = browserRegistration.then(syncBrowserSites,syncBrowserSites);
  return browserRegistration;
}
async function syncBrowserSites() {
  if (!chrome.scripting?.getRegisteredContentScripts) return;
  const {browserSites = []} = await chrome.storage.local.get({browserSites:[]});
  const scripts = [];
  for (const origin of browserSites) {
    const pattern = RadarSites.originPattern(origin);
    if (!pattern || !await chrome.permissions.contains({origins:[pattern]})) continue;
    scripts.push({id:'radar-site-' + new URL(origin).hostname.replace(/[^a-z0-9]/gi,'-'),
      matches:[pattern],js:['marketplaces.js','collector.js'],runAt:'document_idle',persistAcrossSessions:true});
  }
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const owned = existing.filter(s=>s.id.startsWith('radar-site-')).map(s=>s.id);
  if (owned.length) await chrome.scripting.unregisterContentScripts({ids:owned});
  if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
}

async function saveBrowserSearch(input) {
  const url = RadarSites.safeSearchUrl(input.url);
  if (!url) throw new Error('Use uma página HTTPS de busca, sem dados de autenticação no endereço.');
  if (!await chrome.permissions.contains({origins:[RadarSites.originPattern(url)]})) {
    throw new Error('Ative a coleta neste site antes de salvar a busca.');
  }
  const {browserSearches = []} = await chrome.storage.local.get({browserSearches:[]});
  const radarId = input.radar_id ? String(input.radar_id) : null;
  const found = browserSearches.find(s=>s.url===url && s.radar_id===radarId);
  if (!found && browserSearches.length >= 20) throw new Error('Limite de vinte buscas salvas. Remova uma para continuar.');
  const row = {id:found?.id || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
    url,radar_id:radarId,label:String(input.label || new URL(url).hostname).slice(0,100),
    interval_minutes:Math.max(60,Math.min(10080,Number(input.interval_minutes)||240)),
    enabled:true,last_enqueued_at:found?.last_enqueued_at || null};
  await chrome.storage.local.set({browserSearches:[...browserSearches.filter(s=>s.id!==row.id),row]});
  return row;
}

async function dueSavedBrowserJobs(radars, force = false) {
  const {browserSearches=[]} = await chrome.storage.local.get({browserSearches:[]});
  const jobs = [];
  for (const search of browserSearches) {
    if (!search.enabled || !RadarSites.safeSearchUrl(search.url)) continue;
    if (search.radar_id && !radars.some(r=>String(r.id)===String(search.radar_id))) continue;
    const last = Date.parse(search.last_enqueued_at || '');
    if (!force && Number.isFinite(last) && Date.now()-last < search.interval_minutes*60000) continue;
    const site = RadarSites.profile(new URL(search.url).hostname);
    jobs.push({id:`saved:${search.id}:${Date.now()}`,search_id:search.id,source:site.key,
      radar_id:search.radar_id,query:search.label,source_query:search.label,url:search.url,attempts:0});
    search.last_enqueued_at = new Date().toISOString();
  }
  await chrome.storage.local.set({browserSearches});
  return jobs;
}

async function resumeBrowserSource(source) {
  const {browserSourcePauses={}} = await chrome.storage.local.get({browserSourcePauses:{}});
  delete browserSourcePauses[source];
  await chrome.storage.local.set({browserSourcePauses});
  return processAutoBrowseTick(source);
}

chrome.permissions?.onRemoved?.addListener(()=>registerBrowserSites().catch(()=>{}));
