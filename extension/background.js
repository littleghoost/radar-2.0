const RADAR_URL = 'http://127.0.0.1:3130';

async function radarApi(path, options = {}) {
  const response = await fetch(`${RADAR_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Radar respondeu ${response.status}`);
  }

  return data;
}

async function ensureDefaults() {
  const stored = await chrome.storage.local.get([
    'autoCaptureEnabled',
    'autoBrowseEnabled',
    'autoBrowseQueue',
    'autoBrowseLastEnqueuedByRadar',
  ]);

  const next = {};

  if (stored.autoCaptureEnabled === undefined) {
    next.autoCaptureEnabled = true;
  }

  if (stored.autoBrowseEnabled === undefined) {
    next.autoBrowseEnabled = false;
  }

  if (!Array.isArray(stored.autoBrowseQueue)) {
    next.autoBrowseQueue = [];
  }

  if (
    !stored.autoBrowseLastEnqueuedByRadar ||
    typeof stored.autoBrowseLastEnqueuedByRadar !== 'object'
  ) {
    next.autoBrowseLastEnqueuedByRadar = {};
  }

  if (Object.keys(next).length) {
    await chrome.storage.local.set(next);
  }
}

async function ensureAutoBrowseAlarm() {
  const existing = await chrome.alarms.get('radar-auto-browse');

  if (!existing) {
    chrome.alarms.create('radar-auto-browse', {
      periodInMinutes: 2,
    });
  }
}

async function notifyAutoCapture(result) {
  const parts = [];

  if (result.imported > 0) {
    parts.push(`${result.imported} novo(s)`);
  }

  if (result.auto_assigned > 0) {
    parts.push(`${result.auto_assigned} auto-organizado(s)`);
  }

  if (result.price_drops > 0) {
    parts.push(`${result.price_drops} queda(s) de preço`);
  }

  if (!parts.length) {
    return;
  }

  await chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Radar 2.0 Auto-Capture',
    message: parts.join(' • '),
  });
}

async function importAutoCapture(
  capture,
  sender,
  { ignoreAutoCaptureToggle = false } = {},
) {
  const stored = await chrome.storage.local.get({
    autoCaptureEnabled: true,
  });

  if (
    !ignoreAutoCaptureToggle &&
    !stored.autoCaptureEnabled
  ) {
    return { ok: true, skipped: true, reason: 'auto_capture_disabled' };
  }

  if (!capture?.items?.length) {
    return { ok: true, skipped: true, reason: 'no_items' };
  }

  try {
    const result = await radarApi('/api/import/assisted', {
      method: 'POST',
      body: JSON.stringify({
        radar_id: null,
        auto_assign: true,
        capture_mode: 'auto',
        capture_version: Number(capture.version || 5),
        source_url: capture.source_url,
        items: capture.items,
      }),
    });

    let host = capture.platform || 'marketplace';

    try {
      host = new URL(sender?.tab?.url || capture.source_url).hostname;
    } catch {}

    await chrome.storage.local.set({
      lastAutoCaptureAt: new Date().toISOString(),
      lastAutoCaptureHost: host,
      lastAutoCaptureCount: capture.items.length,
      lastAutoCaptureImported: result.imported || 0,
      lastAutoCaptureUpdated: result.updated || 0,
      lastAutoCaptureAutoAssigned: result.auto_assigned || 0,
      lastAutoCapturePriceDrops: result.price_drops || 0,
      lastAutoCaptureError: null,
    });

    await notifyAutoCapture(result).catch(() => {});

    return { ok: true, result };
  } catch (error) {
    await chrome.storage.local.set({
      lastAutoCaptureAt: new Date().toISOString(),
      lastAutoCaptureError: error.message || String(error),
    });

    return { ok: false, error: error.message || String(error) };
  }
}

function autoBrowseSearchUrl(source, query) {
  const clean = String(query || '').trim();
  const encoded = encodeURIComponent(clean);

  if (!clean) return null;

  if (source === 'olx') {
    return `https://www.olx.com.br/brasil?q=${encoded}`;
  }

  if (source === 'enjoei') {
    const slug = clean
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `https://www.enjoei.com.br/${slug || 'busca'}/s?q=${encoded}`;
  }

  if (source === 'mercadolivre') {
    return `https://lista.mercadolivre.com.br/${encoded.replace(/%20/g, '-')}`;
  }

  if (source === 'depop') {
    return `https://www.depop.com/search/?q=${encoded}`;
  }

  return null;
}

function autoBrowseSourcesForRadar(radar = {}) {
  const category = String(
    radar.category || 'geral',
  ).toLowerCase();

  if (category === 'cameras') {
    return ['olx', 'enjoei', 'mercadolivre'];
  }

  if (
    category === 'roupas' ||
    category === 'clothing' ||
    category === 'fashion'
  ) {
    return ['olx', 'enjoei', 'mercadolivre', 'depop'];
  }

  return ['olx', 'enjoei', 'mercadolivre', 'depop'];
}

async function buildDueAutoBrowseJobs({
  force = false,
} = {}) {
  const stored = await chrome.storage.local.get({
    autoBrowseQueue: [],
    autoBrowseLastEnqueuedByRadar: {},
  });

  if (
    Array.isArray(stored.autoBrowseQueue) &&
    stored.autoBrowseQueue.length
  ) {
    return stored.autoBrowseQueue;
  }

  const radars = await radarApi('/api/radars');
  const now = Date.now();
  const lastMap =
    stored.autoBrowseLastEnqueuedByRadar || {};
  const jobs = [];

  for (const radar of radars) {
    if (!radar.schedule_enabled) continue;

    const intervalMinutes = Math.max(
      60,
      Number(
        radar.schedule_interval_minutes || 240,
      ) || 240,
    );
    const lastAt = Date.parse(
      lastMap[String(radar.id)] || '',
    );

    if (
      !force &&
      Number.isFinite(lastAt) &&
      now - lastAt < intervalMinutes * 60_000
    ) {
      continue;
    }

    const plan = await radarApi(
      `/api/radars/${radar.id}/search-plan`,
    );

    const selected = (
      Array.isArray(plan?.queries)
        ? plan.queries
        : []
    )
      .filter(
        (query) =>
          query.next_selected &&
          Boolean(query.enabled),
      )
      .slice(0, 2);

    if (!selected.length) continue;

    for (const query of selected) {
      for (const source of autoBrowseSourcesForRadar(radar)) {
        const url = autoBrowseSearchUrl(
          source,
          query.query_text,
        );

        if (!url) continue;

        jobs.push({
          id:
            `${radar.id}:${source}:${query.id}:${now}`,
          radar_id: radar.id,
          radar_name: radar.name,
          source,
          query: query.query_text,
          url,
          attempts: 0,
          created_at: new Date(now).toISOString(),
        });

        if (jobs.length >= 24) break;
      }

      if (jobs.length >= 24) break;
    }

    if (!force) {
      lastMap[String(radar.id)] =
        new Date(now).toISOString();
    }

    if (jobs.length >= 24) break;
  }

  await chrome.storage.local.set({
    autoBrowseQueue: jobs,
    autoBrowseLastEnqueuedByRadar: lastMap,
  });

  return jobs;
}

function waitForTabComplete(tab, timeoutMs = 30_000) {
  if (tab?.status === 'complete') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tempo limite ao carregar a busca.'));
    }, timeoutMs);

    function listener(tabId, changeInfo) {
      if (
        tabId === tab.id &&
        changeInfo.status === 'complete'
      ) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function delay(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

async function collectFromAutoBrowseTab(
  tabId,
  source = '',
) {
  // Marketplaces renderizam os cards depois do evento load. A OLX, em
  // particular, hidrata os resultados de forma mais confiável quando a
  // aba está ativa; por isso ela recebe uma espera inicial maior.
  await delay(source === 'olx' ? 4200 : 1800);

  let lastError = null;
  let lastCapture = null;

  const maxAttempts = source === 'olx' ? 8 : 6;

  for (
    let attempt = 0;
    attempt < maxAttempts;
    attempt += 1
  ) {
    try {
      const response = await chrome.tabs.sendMessage(
        tabId,
        {
          type: 'radar-collect-now',
          limit: 100,
        },
      );

      if (response?.capture) {
        lastCapture = response.capture;

        if (lastCapture.items?.length) {
          return lastCapture;
        }
      } else {
        lastError = new Error(
          response?.error ||
            'Collector não respondeu.',
        );
      }
    } catch (error) {
      lastError = error;
    }

    // Backoff curto para páginas client-side. A OLX ganha
    // alguns segundos extras porque carrega os cards após a hidratação.
    await delay(
      (source === 'olx' ? 1800 : 1400) +
        attempt * 300,
    );
  }

  // Uma captura vazia válida é diferente de falha do collector.
  if (lastCapture) {
    return lastCapture;
  }

  throw lastError ||
    new Error('Não consegui coletar a busca.');
}

async function runAutoBrowseJob(job) {
  const needsActiveTab = job.source === 'olx';
  const previousTabs = needsActiveTab
    ? await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      })
    : [];
  const previousTab = previousTabs[0] || null;

  const tab = await chrome.tabs.create({
    url: job.url,
    active: needsActiveTab,
  });

  try {
    await waitForTabComplete(tab);

    if (needsActiveTab) {
      await chrome.tabs.update(tab.id, {
        active: true,
      });
      await delay(2200);
    }

    const capture =
      await collectFromAutoBrowseTab(
        tab.id,
        job.source,
      );

    const result = await importAutoCapture(
      capture,
      { tab },
      { ignoreAutoCaptureToggle: true },
    );

    return {
      ok: Boolean(result?.ok),
      capture_count:
        capture?.items?.length || 0,
      imported:
        result?.result?.imported || 0,
      updated:
        result?.result?.updated || 0,
      auto_assigned:
        result?.result?.auto_assigned || 0,
      price_drops:
        result?.result?.price_drops || 0,
      error: result?.error || null,
      diagnostics: capture?.diagnostics || null,
      source_url: capture?.source_url || job.url,
    };
  } finally {
    if (
      needsActiveTab &&
      previousTab?.id
    ) {
      await chrome.tabs
        .update(previousTab.id, {
          active: true,
        })
        .catch(() => {});
      if (previousTab.windowId) {
        await chrome.windows
          .update(previousTab.windowId, {
            focused: true,
          })
          .catch(() => {});
      }
    }

    if (tab?.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

let autoBrowseRunning = false;

async function processAutoBrowseTick(
  preferredSource = null,
  {
    force = false,
  } = {},
) {
  if (autoBrowseRunning) {
    return {
      ok: true,
      skipped: true,
      reason: 'already_running',
    };
  }

  autoBrowseRunning = true;

  try {
    await ensureDefaults();

    // Não consome a fila se o Desktop estiver offline. Sem o backend,
    // a busca até pode abrir, mas nenhum resultado pode ser persistido.
    try {
      await radarApi('/api/health');
    } catch (error) {
      await chrome.storage.local.set({
        lastAutoBrowseAt: new Date().toISOString(),
        lastAutoBrowseError: 'Radar Desktop offline. Fila preservada.',
      });
      return {
        ok: false,
        skipped: true,
        reason: 'radar_offline',
      };
    }

    const stored = await chrome.storage.local.get({
      autoBrowseEnabled: false,
      autoBrowseQueue: [],
    });

    if (!stored.autoBrowseEnabled) {
      return {
        ok: true,
        skipped: true,
        reason: 'auto_browse_disabled',
      };
    }

    let queue = Array.isArray(
      stored.autoBrowseQueue,
    )
      ? stored.autoBrowseQueue
      : [];

    if (!queue.length) {
      queue = await buildDueAutoBrowseJobs({
        force,
      });
    }

    if (!queue.length) {
      await chrome.storage.local.set({
        lastAutoBrowseAt:
          new Date().toISOString(),
        lastAutoBrowseStatus: force
          ? 'Nenhuma busca habilitada disponível.'
          : 'Nenhuma busca agendada está vencida.',
        lastAutoBrowseError: null,
      });

      return {
        ok: true,
        skipped: true,
        reason: 'no_due_jobs',
      };
    }

    let jobIndex = 0;
    if (preferredSource) {
      const preferredIndex =
        queue.findIndex(
          (candidate) =>
            candidate.source ===
            preferredSource,
        );
      if (preferredIndex >= 0) {
        jobIndex = preferredIndex;
      }
    }

    const job = queue[jobIndex];
    const queueWithoutJob = [
      ...queue.slice(0, jobIndex),
      ...queue.slice(jobIndex + 1),
    ];
    let result;

    try {
      result = await runAutoBrowseJob(job);
      queue = queueWithoutJob;
    } catch (error) {
      const attempts =
        Number(job.attempts || 0) + 1;

      if (attempts <= 1) {
        queue = [
          ...queueWithoutJob,
          {
            ...job,
            attempts,
          },
        ];
      } else {
        queue = queueWithoutJob;
      }

      result = {
        ok: false,
        error:
          error?.message || String(error),
        capture_count: 0,
        imported: 0,
        updated: 0,
      };
    }

    await chrome.storage.local.set({
      autoBrowseQueue: queue,
      lastAutoBrowseAt:
        new Date().toISOString(),
      lastAutoBrowseSource: job.source,
      lastAutoBrowseQuery: job.query,
      lastAutoBrowseCount:
        result.capture_count || 0,
      lastAutoBrowseImported:
        result.imported || 0,
      lastAutoBrowseUpdated:
        result.updated || 0,
      lastAutoBrowseRemaining:
        queue.length,
      lastAutoBrowseError:
        result.error || null,
      lastAutoBrowseDiagnostics:
        result.diagnostics || null,
      lastAutoBrowseSourceUrl:
        result.source_url || job.url || null,
      lastAutoBrowseStatus:
        result.ok
          ? `${job.source} • ${job.query}`
          : null,
    });

    return {
      ok: result.ok,
      job,
      result,
      remaining: queue.length,
    };
  } finally {
    autoBrowseRunning = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults().catch(() => {});
  ensureAutoBrowseAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaults().catch(() => {});
  ensureAutoBrowseAlarm().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== 'radar-auto-browse') {
    return;
  }

  processAutoBrowseTick().catch(async (error) => {
    await chrome.storage.local.set({
      lastAutoBrowseAt: new Date().toISOString(),
      lastAutoBrowseError:
        error?.message || String(error),
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'radar-auto-capture') {
    importAutoCapture(message.capture, sender)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error:
            error.message || String(error),
        }),
      );

    return true;
  }

  if (message?.type === 'radar-auto-browse-now') {
    processAutoBrowseTick(
      message?.preferred_source || null,
      {
        force: Boolean(message?.force),
      },
    )
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error:
            error.message || String(error),
        }),
      );

    return true;
  }

  return false;
});

ensureDefaults().catch(() => {});
ensureAutoBrowseAlarm().catch(() => {});
