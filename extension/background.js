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
  ]);

  const next = {};

  if (stored.autoCaptureEnabled === undefined) {
    next.autoCaptureEnabled = true;
  }

  if (Object.keys(next).length) {
    await chrome.storage.local.set(next);
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

async function importAutoCapture(capture, sender) {
  const stored = await chrome.storage.local.get({
    autoCaptureEnabled: true,
  });

  if (!stored.autoCaptureEnabled) {
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

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaults().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'radar-auto-capture') {
    return false;
  }

  importAutoCapture(message.capture, sender)
    .then(sendResponse)
    .catch((error) =>
      sendResponse({ ok: false, error: error.message || String(error) }),
    );

  return true;
});

ensureDefaults().catch(() => {});
