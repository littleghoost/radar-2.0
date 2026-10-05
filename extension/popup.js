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
    await loadAutoCaptureState();
    await loadAutoBrowseState();
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

async function loadAutoCaptureState() {
  const stored = await chrome.storage.local.get({
    autoCaptureEnabled: true,
    lastAutoCaptureAt: null,
    lastAutoCaptureHost: null,
    lastAutoCaptureCount: 0,
    lastAutoCaptureImported: 0,
    lastAutoCaptureUpdated: 0,
    lastAutoCaptureAutoAssigned: 0,
    lastAutoCapturePriceDrops: 0,
    lastAutoCaptureError: null,
  });

  const checkbox = $('#autoCaptureEnabled');
  const status = $('#autoCaptureStatus');

  if (checkbox) {
    checkbox.checked = Boolean(stored.autoCaptureEnabled);
  }

  if (!status) return;

  if (!stored.autoCaptureEnabled) {
    status.textContent = 'Desligado. A captura manual continua disponível.';
    return;
  }

  if (stored.lastAutoCaptureError) {
    status.textContent = `Ligado • última tentativa: ${stored.lastAutoCaptureError}`;
    return;
  }

  if (stored.lastAutoCaptureAt) {
    const time = new Date(stored.lastAutoCaptureAt).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });

    status.textContent =
      `Ligado • Inbox + auto-organização • ${stored.lastAutoCaptureHost || 'marketplace'} • ` +
      `${stored.lastAutoCaptureCount || 0} lidos • ` +
      `${stored.lastAutoCaptureImported || 0} novos • ` +
      `${stored.lastAutoCaptureUpdated || 0} atualizados • ` +
      `${stored.lastAutoCaptureAutoAssigned || 0} organizados • ` +
      `${stored.lastAutoCapturePriceDrops || 0} quedas • ${time}`;

    return;
  }

  status.textContent =
    'Ligado • Inbox + auto-organização • aguardando página compatível.';
}

async function loadAutoBrowseState() {
  const stored = await chrome.storage.local.get({
    autoBrowseEnabled: false,
    autoBrowseQueue: [],
    lastAutoBrowseAt: null,
    lastAutoBrowseSource: null,
    lastAutoBrowseQuery: null,
    lastAutoBrowseCount: 0,
    lastAutoBrowseImported: 0,
    lastAutoBrowseUpdated: 0,
    lastAutoBrowseRemaining: 0,
    lastAutoBrowseError: null,
    lastAutoBrowseStatus: null,
    lastAutoBrowseDiagnostics: null,
  });

  const checkbox = $('#autoBrowseEnabled');
  const status = $('#autoBrowseStatus');
  const runButton = $('#runAutoBrowseNow');

  if (checkbox) {
    checkbox.checked =
      Boolean(stored.autoBrowseEnabled);
  }

  if (runButton) {
    runButton.disabled =
      !stored.autoBrowseEnabled;
  }

  if (!status) return;

  if (!stored.autoBrowseEnabled) {
    status.textContent =
      'Desligado • nenhuma aba será aberta automaticamente.';
    return;
  }

  const queueCount = Array.isArray(
    stored.autoBrowseQueue,
  )
    ? stored.autoBrowseQueue.length
    : Number(stored.lastAutoBrowseRemaining || 0);

  if (stored.lastAutoBrowseError) {
    status.textContent =
      `Ligado • última busca falhou: ${stored.lastAutoBrowseError} • fila ${queueCount}`;
    return;
  }

  if (stored.lastAutoBrowseAt) {
    const time = new Date(
      stored.lastAutoBrowseAt,
    ).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });

    const d = stored.lastAutoBrowseDiagnostics || {};
    const diagnosticText =
      Number(stored.lastAutoBrowseCount || 0) === 0 &&
      Object.keys(d).length
        ? ` • diag URLs ${d.listingUrls ?? '?'} → válidas ${d.passedUrl ?? '?'} → cards ${d.passedVisible ?? '?'} → img ${d.passedImage ?? '?'} → texto ${d.passedText ?? '?'} → título ${d.passedTitle ?? '?'}`
        : '';

    const bridgeVersion = chrome.runtime.getManifest().version;

    status.textContent =
      `Ligado [v${bridgeVersion}] • ${stored.lastAutoBrowseStatus || 'aguardando'} • ` +
      `${stored.lastAutoBrowseCount || 0} lidos • ` +
      `${stored.lastAutoBrowseImported || 0} novos • ` +
      `${stored.lastAutoBrowseUpdated || 0} atualizados • ` +
      `fila ${queueCount} • ${time}${diagnosticText}`;
    return;
  }

  status.textContent =
    'Ligado • aguardando a próxima verificação do Search Planner.';
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
    const d = lastCapture && lastCapture.diagnostics ? lastCapture.diagnostics : {};
    preview.innerHTML = '<strong>0 anúncios detectados</strong>' + 'URLs: ' + (d.listingUrls ?? '?') + ' → válidas: ' + (d.passedUrl ?? '?') + ' → visíveis: ' + (d.passedVisible ?? '?') + ' → c/ imagem: ' + (d.passedImage ?? '?') + ' → c/ texto: ' + (d.passedText ?? '?') + ' → c/ título: ' + (d.passedTitle ?? '?') + '<br><small>Links: ' + (d.anchors ?? '?') + ' • Imagens pág.: ' + (d.images ?? '?') + ' • Preços pág.: ' + (d.priceTexts ?? '?') + '</small>';
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
    $('#preview').innerHTML = `<strong>${result.imported} importado(s) • ${result.updated || 0} atualizado(s)</strong>${result.duplicates} sem mudança • ${result.invalid} inválido(s) • ${result.failed} falha(s)`;
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

$('#autoCaptureEnabled').addEventListener('change', async () => {
  const enabled = $('#autoCaptureEnabled').checked;

  await chrome.storage.local.set({
    autoCaptureEnabled: enabled,
  });

  await loadAutoCaptureState();
});

$('#autoBrowseEnabled')?.addEventListener(
  'change',
  async () => {
    const enabled =
      $('#autoBrowseEnabled').checked;

    await chrome.storage.local.set({
      autoBrowseEnabled: enabled,
      ...(enabled
        ? {}
        : {
            autoBrowseQueue: [],
            lastAutoBrowseRemaining: 0,
          }),
    });

    await loadAutoBrowseState();
  },
);

$('#runAutoBrowseNow')?.addEventListener(
  'click',
  async () => {
    const button = $('#runAutoBrowseNow');
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Rodando...';

    try {
      const result =
        await chrome.runtime.sendMessage({
          type: 'radar-auto-browse-now',
        });

      if (!result?.ok && !result?.skipped) {
        throw new Error(
          result?.error ||
            result?.result?.error ||
            'A busca automática falhou.',
        );
      }
    } catch (error) {
      await chrome.storage.local.set({
        lastAutoBrowseAt:
          new Date().toISOString(),
        lastAutoBrowseError:
          error?.message || String(error),
      });
    } finally {
      button.textContent = original;
      await loadAutoBrowseState();
    }
  },
);

$('#radarSelect').addEventListener('change', async () => {
  const radarId = $('#radarSelect').value || null;
  await chrome.storage.local.set({ lastRadarId: radarId });
});

activeTab().then((tab) => {
  try { $('#pageHost').textContent = new URL(tab.url).hostname; } catch { $('#pageHost').textContent = 'aba atual'; }
}).catch(() => {});

loadRadarStatus();
