const RADAR_URL = 'http://127.0.0.1:3130';
importScripts('marketplaces.js', 'browserSearches.js');

async function radarApi(path, options = {}) {
  const response = await fetch(`${RADAR_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(path === '/api/import/assisted' ? 120_000 : 15_000),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || `Radar respondeu ${response.status}`);
    error.retryable = response.status >= 500 || [408, 429].includes(response.status);
    throw error;
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

async function setAutoBrowseProgress({
  running = false,
  percent = 0,
  message = '',
  detail = '',
  found = 0,
  tried = 0,
  total = 0,
  empty = 0,
} = {}) {
  await chrome.storage.local.set({
    autoBrowseProgressRunning: Boolean(running),
    autoBrowseProgressPercent: Math.max(
      0,
      Math.min(100, Math.round(Number(percent) || 0)),
    ),
    autoBrowseProgressMessage: String(
      message || '',
    ).slice(0, 180),
    autoBrowseProgressDetail: String(
      detail || '',
    ).slice(0, 240),
    autoBrowseProgressFound:
      Math.max(0, Number(found) || 0),
    autoBrowseProgressTried:
      Math.max(0, Number(tried) || 0),
    autoBrowseProgressTotal:
      Math.max(0, Number(total) || 0),
    autoBrowseProgressEmpty:
      Math.max(0, Number(empty) || 0),
    autoBrowseProgressUpdatedAt:
      new Date().toISOString(),
  });
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
  { ignoreAutoCaptureToggle = false, radarId = null } = {},
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
        radar_id: radarId,
        auto_assign: !radarId,
        capture_mode: 'auto',
        capture_version: Number(capture.version || 5),
        source_url: capture.source_url,
        items: capture.items,
      }),
    });

    let host = capture.platform || 'marketplace';
    const partialError = Number(result.failed || 0) > 0
      ? `${result.failed} anúncio(s) não foram salvos. A captura será tentada novamente.`
      : null;

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
      lastAutoCaptureError: partialError,
    });

    await notifyAutoCapture(result).catch(() => {});

    return { ok: !partialError, result, ...(partialError ? {error: partialError, retryable: true} : {}) };
  } catch (error) {
    await chrome.storage.local.set({
      lastAutoCaptureAt: new Date().toISOString(),
      lastAutoCaptureError: error.message || String(error),
    });

    return { ok: false, error: error.message || String(error), retryable: error.retryable !== false };
  }
}

function sourceOptimizedQuery(
  source,
  query,
  radar = {},
) {
  let clean = String(query || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return '';

  if (source === 'olx') {
    const category = String(
      radar.category || '',
    ).toLowerCase();

    if (
      category === 'roupas' ||
      category === 'clothing' ||
      category === 'fashion'
    ) {
      clean = clean
        .replace(
          /\b(?:vintage|original|rare|raro|raridade)\b/gi,
          ' ',
        )
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (category === 'cameras') {
      const model = clean.match(
        /\b(?:DCR|HDR)-(?:SR|XR)[A-Z0-9-]*\b/i,
      )?.[0];

      if (model) {
        clean = `Sony Handycam ${model.toUpperCase()}`;
      } else if (
        /\b(?:vis[aã]o noturna|night\s*shot|nightshot)\b/i.test(
          clean,
        )
      ) {
        clean = 'Sony Handycam NightShot';
      } else if (
        /\b(?:hard disk|hdd)\b/i.test(clean)
      ) {
        clean = 'Sony Handycam HDD';
      }
    }
  }

  return clean
    .replace(/\s+/g, ' ')
    .trim();
}

function autoBrowseSearchUrl(
  source,
  query,
  radar = {},
) {
  const clean = sourceOptimizedQuery(
    source,
    query,
    radar,
  );
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
    !force &&
    Array.isArray(stored.autoBrowseQueue) &&
    stored.autoBrowseQueue.length
  ) {
    return stored.autoBrowseQueue;
  }

  const radars = await radarApi('/api/radars');
  const now = Date.now();
  const lastMap =
    stored.autoBrowseLastEnqueuedByRadar || {};
  const jobs = await dueSavedBrowserJobs(radars, force);

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
      .slice(0, force ? 4 : 2);

    if (!selected.length) continue;

    for (const query of selected) {
      for (const source of autoBrowseSourcesForRadar(radar)) {
        const sourceQuery =
          sourceOptimizedQuery(
            source,
            query.query_text,
            radar,
          );
        const url = autoBrowseSearchUrl(
          source,
          sourceQuery,
          radar,
        );

        if (!url) continue;

        const duplicate = jobs.some(
          (job) =>
            job.radar_id === radar.id &&
            job.source === source &&
            String(
              job.source_query || job.query,
            ).toLowerCase() ===
              sourceQuery.toLowerCase(),
        );
        if (duplicate) continue;

        jobs.push({
          id:
            `${radar.id}:${source}:${query.id}:${now}`,
          radar_id: radar.id,
          radar_name: radar.name,
          source,
          query: query.query_text,
          source_query: sourceQuery,
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
        if (lastCapture.diagnostics?.requiresUserAction) return lastCapture;

        if (
          lastCapture.diagnostics?.noResults
        ) {
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

let currentAutoBrowseWorker = null;

async function createAutoBrowseWorker(url) {
  try {
    const workerWindow =
      await chrome.windows.create({
        url,
        type: 'popup',
        focused: false,
        state: 'minimized',
      });

    const tabs = await chrome.tabs.query({
      windowId: workerWindow.id,
    });
    const tab = tabs[0];

    if (!tab?.id) {
      throw new Error(
        'Janela de trabalho criada sem aba.',
      );
    }

    return {
      mode: 'minimized_window',
      windowId: workerWindow.id,
      tab,
    };
  } catch {
    // Fallback compatível com navegadores Chromium que restrinjam
    // janelas minimizadas criadas por extensão.
    const tab = await chrome.tabs.create({
      url,
      active: false,
    });

    return {
      mode: 'background_tab',
      windowId: null,
      tab,
    };
  }
}

async function closeAutoBrowseWorker(worker) {
  if (!worker) return;

  if (worker.windowId) {
    await chrome.windows
      .remove(worker.windowId)
      .catch(() => {});
    return;
  }

  if (worker.tab?.id) {
    await chrome.tabs
      .remove(worker.tab.id)
      .catch(() => {});
  }
}

async function runAutoBrowseJob(job) {
  const pattern = RadarSites.originPattern(job.url);
  const {disabledBrowserOrigins=[]}=await chrome.storage.local.get({disabledBrowserOrigins:[]});
  if (disabledBrowserOrigins.includes(new URL(job.url).origin)) return {ok:false,retryable:false,error:'Coleta desativada neste site.'};
  if (!pattern || !await chrome.permissions.contains({origins:[pattern]})) {
    return {ok:false,requires_user_action:true,reason:'permission_required',retryable:false,
      error:'Ative a coleta neste site pelo popup da Bridge.',source_url:job.url};
  }
  let worker;
  if (job.resume_tab_id) {
    try { worker = {tab:await chrome.tabs.get(job.resume_tab_id),windowId:job.resume_window_id || null}; } catch {}
  }
  worker ||= await createAutoBrowseWorker(job.url);
  currentAutoBrowseWorker = worker;
  const tab = worker.tab;

  try {
    await waitForTabComplete(tab);

    const capture =
      await collectFromAutoBrowseTab(
        tab.id,
        job.source,
      );
    if (capture.diagnostics?.requiresUserAction) {
      worker.keepOpen = true;
      return {ok:false,requires_user_action:true,retryable:false,
        reason:capture.diagnostics.requiresUserAction,
        error:'A página pede login ou verificação. Abra a página pendente e continue após concluir.',
        source_url:job.url,tab_id:tab.id,window_id:worker.windowId};
    }

    const result = await importAutoCapture(
      capture,
      { tab },
      { ignoreAutoCaptureToggle: true, radarId:job.radar_id },
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
      retryable: result?.retryable,
      diagnostics: capture?.diagnostics || null,
      source_url: capture?.source_url || job.url,
    };
  } finally {
    if (!worker.keepOpen) await closeAutoBrowseWorker(worker);
    if (
      currentAutoBrowseWorker === worker
    ) {
      currentAutoBrowseWorker = null;
    }
  }
}

let autoBrowseRunning = false;
let autoBrowseCancelRequested = false;

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
  autoBrowseCancelRequested = false;

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
      await setAutoBrowseProgress({
        running: false,
        percent: 100,
        message: 'Radar Desktop offline',
        detail: 'Fila preservada para a próxima tentativa.',
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
      browserSourcePauses: {},
    });
    const pausedSources = stored.browserSourcePauses || {};

    if (!stored.autoBrowseEnabled) {
      await setAutoBrowseProgress({
        running: false,
        percent: 0,
        message: '',
        detail: '',
      });
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

    // O clique manual representa “rode agora”. Filas antigas, sem
    // source_query, são descartadas; uma fila nova desta versão continua
    // de onde parou para não repetir as mesmas buscas vazias.
    if (force) {
      queue = queue.filter(
        (job) => Boolean(job?.source_query),
      );

      const hasPreferredJobs =
        !preferredSource ||
        queue.some(
          (job) =>
            job.source === preferredSource,
        );

      if (
        !queue.length ||
        !hasPreferredJobs
      ) {
        queue = await buildDueAutoBrowseJobs({
          force: true,
        });
      }
    } else if (!queue.length) {
      queue = await buildDueAutoBrowseJobs({
        force: false,
      });
    }

    if (!queue.length) {
      const emptyMessage = force
        ? 'Nenhuma busca habilitada disponível.'
        : 'Nenhuma busca agendada está vencida.';

      await chrome.storage.local.set({
        lastAutoBrowseAt:
          new Date().toISOString(),
        lastAutoBrowseStatus: emptyMessage,
        lastAutoBrowseError: null,
      });
      await setAutoBrowseProgress({
        running: false,
        percent: 100,
        message: emptyMessage,
      });

      return {
        ok: true,
        skipped: true,
        reason: 'no_due_jobs',
      };
    }

    const maxJobs = force ? 4 : 2;
    const availableJobs = preferredSource
      ? queue.filter(
          (candidate) =>
            candidate.source ===
            preferredSource,
        ).length
      : queue.length;
    const progressTotal = Math.max(
      1,
      Math.min(maxJobs, availableJobs || maxJobs),
    );

    await setAutoBrowseProgress({
      running: true,
      percent: 2,
      message: 'Preparando buscas...',
      detail: preferredSource
        ? `Fonte: ${preferredSource}`
        : 'Search Planner',
      total: progressTotal,
    });

    let jobsTried = 0;
    let emptyJobsSkipped = 0;
    let totalFound = 0;
    let totalImported = 0;
    let totalUpdated = 0;
    let totalAssigned = 0;
    let job = null;
    let result = null;
    let autoBrowseDisabled = false;
    const attemptedJobs = new Set();

    while (
      queue.length &&
      jobsTried < maxJobs
    ) {
      let jobIndex = queue.findIndex((candidate) => !attemptedJobs.has(candidate.id) && !pausedSources[candidate.source]);

      if (preferredSource) {
        const preferredIndex =
          queue.findIndex(
            (candidate) =>
              candidate.source === preferredSource && !attemptedJobs.has(candidate.id) && !pausedSources[candidate.source],
          );

        if (preferredIndex >= 0) {
          jobIndex = preferredIndex;
        } else if (force) {
          break;
        }
      }

      if (jobIndex < 0) break;

      job = queue[jobIndex];
      attemptedJobs.add(job.id);
      const queueWithoutJob = [
        ...queue.slice(0, jobIndex),
        ...queue.slice(jobIndex + 1),
      ];
      const currentQuery =
        job.source_query ||
        job.query ||
        '';

      await setAutoBrowseProgress({
        running: true,
        percent: Math.max(
          5,
          Math.round(
            (jobsTried / progressTotal) * 90,
          ),
        ),
        message: `Buscando: ${currentQuery}`,
        detail: `${job.source} • tentativa ${jobsTried + 1} de ${progressTotal}`,
        tried: jobsTried,
        total: progressTotal,
        empty: emptyJobsSkipped,
      });

      try {
        result = await runAutoBrowseJob(job);
        if (result?.requires_user_action) {
          pausedSources[job.source] = {reason:result.reason,url:job.url,tab_id:result.tab_id || null};
          queue = [...queueWithoutJob,{...job,resume_tab_id:result.tab_id,resume_window_id:result.window_id}];
          await chrome.storage.local.set({browserSourcePauses:pausedSources,autoBrowseQueue:queue});
          break;
        }
        if (!result?.ok && result?.retryable !== false) {
          throw Object.assign(new Error(result?.error || 'Não consegui salvar a captura.'), {result});
        }
        queue = queueWithoutJob;
      } catch (error) {
        const attempts =
          Number(job.attempts || 0) + 1;

        if (autoBrowseCancelRequested) {
          // Closing the worker is cancellation, not a completed search.
        } else if (attempts <= 1 && error.retryable !== false) {
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

        result = error.result || {
          ok: false,
          error:
            error?.message || String(error),
          capture_count: 0,
          imported: 0,
          updated: 0,
        };
      }

      jobsTried += 1;

      const captureCount = Number(
        result?.capture_count || 0,
      );
      totalFound += captureCount;
      totalImported += Number(
        result?.imported || 0,
      );
      totalUpdated += Number(
        result?.updated || 0,
      );
      totalAssigned += Number(
        result?.auto_assigned || 0,
      );

      const latest = await chrome.storage.local.get({autoBrowseEnabled: false,browserSearches:[]});
      autoBrowseDisabled = !latest.autoBrowseEnabled;
      if (autoBrowseDisabled) queue = [];
      queue = queue.filter(candidate=>!candidate.search_id || latest.browserSearches.some(s=>s.id===candidate.search_id));
      // Persist each completed attempt before the service worker can sleep.
      await chrome.storage.local.set({autoBrowseQueue: queue});

      if (autoBrowseCancelRequested || autoBrowseDisabled) {
        break;
      }

      if (captureCount > 0) {
        await setAutoBrowseProgress({
          running: true,
          percent: 96,
          message: `${captureCount} anúncio(s) encontrado(s)`,
          detail: `${job.source} • ${currentQuery}`,
          found: captureCount,
          tried: jobsTried,
          total: progressTotal,
          empty: emptyJobsSkipped,
        });
        break;
      }

      if (result?.error) {
        await setAutoBrowseProgress({
          running: true,
          percent: Math.min(
            92,
            Math.round(
              (jobsTried / progressTotal) * 90,
            ),
          ),
          message: force
            ? 'Falha nesta busca — pulando'
            : 'Falha nesta busca',
          detail: result.error,
          tried: jobsTried,
          total: progressTotal,
          empty: emptyJobsSkipped,
        });

        if (!force) {
          break;
        }

        emptyJobsSkipped += 1;
        await delay(350);
        continue;
      }

      emptyJobsSkipped += 1;

      await setAutoBrowseProgress({
        running: true,
        percent: Math.min(
          92,
          Math.round(
            (jobsTried / progressTotal) * 90,
          ),
        ),
        message: result?.diagnostics?.noResults
          ? '0 resultados — pulando para a próxima'
          : 'Nenhum anúncio detectado — tentando a próxima',
        detail: `${job.source} • ${currentQuery}`,
        tried: jobsTried,
        total: progressTotal,
        empty: emptyJobsSkipped,
      });

      await delay(350);
    }

    if (!job && queue.length && Object.keys(pausedSources).length) {
      result = {ok:true,requires_user_action:true,capture_count:0,
        error:'Conclua a etapa pendente pelo painel Sites e buscas com sua conta.'};
    }
    if (!result) {
      result = {
        ok: true,
        capture_count: 0,
        imported: 0,
        updated: 0,
      };
    }

    const displayedQuery =
      job?.source_query ||
      job?.query ||
      '';

    const finalFound = totalFound;
    const finalMessage = result?.requires_user_action ? 'Busca aguardando você' : autoBrowseDisabled
      ? 'Busca desativada'
      : autoBrowseCancelRequested
      ? 'Busca cancelada'
      : result?.error
        ? 'Busca interrompida por erro'
        : finalFound > 0
          ? `Concluído: ${finalFound} anúncio(s) em ${jobsTried} busca(s)`
          : `Concluído: nenhum anúncio nas ${jobsTried} busca(s)`;

    await setAutoBrowseProgress({
      running: false,
      percent: 100,
      message: finalMessage,
      detail: [
        emptyJobsSkipped
          ? `${emptyJobsSkipped} vazia(s)`
          : null,
        totalImported
          ? `${totalImported} novo(s)`
          : null,
        totalUpdated
          ? `${totalUpdated} atualizado(s)`
          : null,
        totalAssigned
          ? `${totalAssigned} organizado(s)`
          : null,
        !emptyJobsSkipped &&
        !totalImported &&
        !totalUpdated &&
        !totalAssigned
          ? displayedQuery
          : null,
      ]
        .filter(Boolean)
        .join(' • '),
      found: finalFound,
      tried: jobsTried,
      total: progressTotal,
      empty: emptyJobsSkipped,
    });

    await chrome.storage.local.set({
      autoBrowseQueue: queue,
      lastAutoBrowseAt:
        new Date().toISOString(),
      lastAutoBrowseSource:
        job?.source || preferredSource || null,
      lastAutoBrowseQuery: displayedQuery,
      lastAutoBrowseCount: totalFound,
      lastAutoBrowseImported: totalImported,
      lastAutoBrowseUpdated: totalUpdated,
      lastAutoBrowseRemaining:
        queue.length,
      lastAutoBrowseError:
        autoBrowseCancelRequested || autoBrowseDisabled
          ? null
          : result.error || null,
      lastAutoBrowseDiagnostics:
        result.diagnostics || null,
      lastAutoBrowseSourceUrl:
        result.source_url || job?.url || null,
      lastAutoBrowseJobsTried: jobsTried,
      lastAutoBrowseEmptySkipped:
        emptyJobsSkipped,
      lastAutoBrowseStatus:
        result.ok
          ? [
              job?.source,
              displayedQuery,
              emptyJobsSkipped
                ? `${emptyJobsSkipped} busca(s) vazia(s) pulada(s)`
                : null,
            ]
              .filter(Boolean)
              .join(' • ')
          : null,
    });

    return {
      ok: autoBrowseCancelRequested
        ? true
        : result.ok,
      cancelled: autoBrowseCancelRequested,
      job,
      result,
      jobs_tried: jobsTried,
      empty_skipped: emptyJobsSkipped,
      remaining: queue.length,
    };
  } finally {
    autoBrowseRunning = false;
    autoBrowseCancelRequested = false;
    currentAutoBrowseWorker = null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  registerBrowserSites().catch(() => {});
  ensureDefaults().catch(() => {});
  ensureAutoBrowseAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  registerBrowserSites().catch(() => {});
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
  const browserActions = {
    'radar-register-sites':()=>registerBrowserSites(),
    'radar-save-search':()=>saveBrowserSearch(message.search || {}),
    'radar-resume-source':()=>resumeBrowserSource(String(message.source || '')),
  };
  if (browserActions[message?.type] && sender.id === chrome.runtime.id && !sender.tab) {
    browserActions[message.type]().then(result=>sendResponse({ok:true,result}))
      .catch(error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
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

  if (message?.type === 'radar-auto-browse-cancel') {
    autoBrowseCancelRequested = true;

    const worker = currentAutoBrowseWorker;
    closeAutoBrowseWorker(worker)
      .catch(() => {})
      .finally(async () => {
        if (
          currentAutoBrowseWorker === worker
        ) {
          currentAutoBrowseWorker = null;
        }

        await setAutoBrowseProgress({
          running: false,
          percent: 100,
          message: 'Cancelando busca...',
          detail: 'A fila restante foi preservada.',
        });

        sendResponse({
          ok: true,
          cancelled: true,
        });
      });

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
registerBrowserSites().catch(() => {});
