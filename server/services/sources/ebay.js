let tokenCache = null;

function getConfig() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const marketplaceId = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

  return { clientId, clientSecret, marketplaceId };
}

async function getApplicationToken() {
  const { clientId, clientSecret } = getConfig();

  if (!clientId || !clientSecret) return null;

  if (tokenCache && tokenCache.expiresAt - Date.now() > 60_000) {
    return tokenCache.accessToken;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  });

  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || 'Falha ao obter token do eBay.');
    error.status = response.status;
    throw error;
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 0) * 1000,
  };

  return tokenCache.accessToken;
}

function normalizeItems(data) {
  return (Array.isArray(data.itemSummaries) ? data.itemSummaries : []).map((item) => ({
    source: 'ebay',
    external_id: item.itemId || null,
    title: item.title || '',
    platform: 'eBay',
    url: item.itemWebUrl || null,
    image_url: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
    price: item.price?.value == null ? null : Number(item.price.value),
    currency: item.price?.currency || null,
  }));
}

async function requestBrowse(url, accessToken, marketplaceId, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
      accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.errors?.[0]?.message || 'request_failed');
    error.status = response.status;
    throw error;
  }
  return data;
}

async function searchEbay({ query, limit = 50, referenceImageBuffer = null }) {
  const { clientId, clientSecret, marketplaceId } = getConfig();

  if (!clientId || !clientSecret) {
    return {
      source: 'ebay',
      ok: false,
      skipped: true,
      reason: 'credentials_pending',
      items: [],
    };
  }

  try {
    const accessToken = await getApplicationToken();
    const keywordUrl = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
    keywordUrl.searchParams.set('q', query);
    keywordUrl.searchParams.set('limit', String(Math.min(200, Math.max(1, limit))));

    const requests = [
      requestBrowse(keywordUrl, accessToken, marketplaceId).then((data) => ({ mode: 'keyword', data })),
    ];

    const imageSupported = ['EBAY_US', 'EBAY_DE', 'EBAY_GB', 'EBAY_AU'].includes(marketplaceId);
    if (referenceImageBuffer && imageSupported) {
      const imageUrl = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search_by_image');
      imageUrl.searchParams.set('limit', String(Math.min(200, Math.max(1, limit))));
      requests.push(
        requestBrowse(imageUrl, accessToken, marketplaceId, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ image: referenceImageBuffer.toString('base64') }),
        }).then((data) => ({ mode: 'image', data })),
      );
    }

    const settled = await Promise.allSettled(requests);
    const itemsByKey = new Map();
    const modes = [];
    const errors = [];

    for (const result of settled) {
      if (result.status === 'rejected') {
        errors.push(result.reason?.message || String(result.reason));
        continue;
      }
      modes.push(result.value.mode);
      for (const item of normalizeItems(result.value.data)) {
        const key = item.external_id || item.url || `${item.title}|${item.price}`;
        if (!itemsByKey.has(key)) itemsByKey.set(key, item);
      }
    }

    if (!itemsByKey.size && errors.length) {
      return {
        source: 'ebay',
        ok: false,
        status: 502,
        reason: errors.join(' | '),
        items: [],
      };
    }

    return {
      source: 'ebay',
      ok: true,
      modes,
      image_search_supported: imageSupported,
      partial_errors: errors,
      items: [...itemsByKey.values()].slice(0, limit * 2),
    };
  } catch (err) {
    return {
      source: 'ebay',
      ok: false,
      status: err.status || 500,
      reason: err.message,
      items: [],
    };
  }
}

function getEbayStatus() {
  const { clientId, clientSecret, marketplaceId } = getConfig();
  return {
    source: 'ebay',
    configured: Boolean(clientId && clientSecret),
    marketplace_id: marketplaceId,
    keyword_search: true,
    image_search: ['EBAY_US', 'EBAY_DE', 'EBAY_GB', 'EBAY_AU'].includes(marketplaceId),
  };
}

module.exports = { searchEbay, getEbayStatus };
