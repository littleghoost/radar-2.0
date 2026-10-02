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

async function searchEbay({ query, limit = 50 }) {
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
    const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
        accept: 'application/json',
      },
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        source: 'ebay',
        ok: false,
        status: response.status,
        reason: data.errors?.[0]?.message || 'request_failed',
        items: [],
      };
    }

    const items = (Array.isArray(data.itemSummaries) ? data.itemSummaries : []).map((item) => ({
      source: 'ebay',
      external_id: item.itemId || null,
      title: item.title || '',
      platform: 'eBay',
      url: item.itemWebUrl || null,
      image_url: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
      price: item.price?.value == null ? null : Number(item.price.value),
      currency: item.price?.currency || null,
    }));

    return { source: 'ebay', ok: true, items };
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
  };
}

module.exports = { searchEbay, getEbayStatus };
