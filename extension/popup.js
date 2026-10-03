const RADAR_URL = 'http://127.0.0.1:3130';
let lastCapture = null;

const $ = (selector) => document.querySelector(selector);

async function radarApi(path, options = {}) {
  const response = await fetch(`${RADAR_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Radar respondeu ${response.status}`);
  return data;
}

async function loadRadarStatus() {
  try {
    await radarApi('/api/health');
    $('#statusDot').className = 'dot online';
    $('#offlineCard').hidden = true;
    $('#mainCard').hidden = false;
    await loadRadars();
  } catch {
    $('#statusDot').className = 'dot offline';
    $('#offlineCard').hidden = false;
    $('#mainCard').hidden = true;
  }
}

async function loadRadars() {
  const radars = await radarApi('/api/radars');
  const select = $('#radarSelect');
  const stored = await chrome.storage.local.get(['lastRadarId']);
  select.innerHTML = '<option value="">Sem radar</option>' + radars
    .map((radar) => `<option value="${radar.id}">${escapeHtml(radar.name)}</option>`)
    .join('');
  if (stored.lastRadarId && radars.some((radar) => String(radar.id) === String(stored.lastRadarId))) {
    select.value = String(stored.lastRadarId);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Nenhuma aba ativa encontrada.');
  return tab;
}

async function scanPage() {
  const tab = await activeTab();
  if (!/^https?:/i.test(tab.url || '')) throw new Error('Abra uma página normal de marketplace para analisar.');
  $('#pageHost').textContent = new URL(tab.url).hostname;

  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['collector.js'] });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => globalThis.__radarCollectVisibleListings?.(100) || null,
  });

  if (!result?.result) throw new Error('Não consegui ler esta página.');
  lastCapture = result.result;
  renderPreview();
}

function renderPreview() {
  const preview = $('#preview');
  const send = $('#sendItems');
  if (!lastCapture?.items?.length) {
    preview.innerHTML = '<strong>0 anúncios detectados</strong>Tente rolar a página para carregar mais cards e analisar novamente.';
    send.disabled = true;
    return;
  }

  const items = lastCapture.items;
  const images = items.filter((item) => item.image_url).length;
  const prices = items.filter((item) => item.current_price !== null && item.current_price !== undefined).length;
  preview.innerHTML = `<strong>${items.length} anúncios detectados</strong>${images} com imagem • ${prices} com preço • ${escapeHtml(lastCapture.platform)}`;
  send.disabled = false;
  send.textContent = `Enviar ${items.length} para o Radar`;
}

async function sendItems() {
  if (!lastCapture?.items?.length) return;
  const button = $('#sendItems');
  button.disabled = true;
  button.textContent = 'Enviando...';
  try {
    const radarId = $('#radarSelect').value || null;
    await chrome.storage.local.set({ lastRadarId: radarId });
    const result = await radarApi('/api/import/assisted', {
      method: 'POST',
      body: JSON.stringify({
        radar_id: radarId,
        source_url: lastCapture.source_url,
        items: lastCapture.items,
      }),
    });
    $('#preview').innerHTML = `<strong>${result.imported} importado(s)</strong>${result.duplicates} duplicado(s) • ${result.invalid} inválido(s) • ${result.failed} falha(s)`;
    button.textContent = result.imported ? 'Enviado ✓' : 'Nada novo';
  } catch (error) {
    $('#preview').innerHTML = `<strong>Falha ao importar</strong>${escapeHtml(error.message)}`;
    button.textContent = 'Tentar novamente';
    button.disabled = false;
  }
}

$('#scanPage').addEventListener('click', async () => {
  const button = $('#scanPage');
  button.disabled = true;
  button.textContent = 'Analisando...';
  try {
    await scanPage();
  } catch (error) {
    $('#preview').innerHTML = `<strong>Não consegui analisar</strong>${escapeHtml(error.message)}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Analisar página atual';
  }
});

$('#sendItems').addEventListener('click', sendItems);
$('#openRadar').addEventListener('click', () => chrome.tabs.create({ url: RADAR_URL }));
$('#radarSelect').addEventListener('change', () => chrome.storage.local.set({ lastRadarId: $('#radarSelect').value || null }));

activeTab().then((tab) => {
  try { $('#pageHost').textContent = new URL(tab.url).hostname; } catch { $('#pageHost').textContent = 'aba atual'; }
}).catch(() => {});

loadRadarStatus();
