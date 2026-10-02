async function searchMercadoLivre({ query, accessToken, limit = 50 }) {
  if (!accessToken) {
    return {
      source: 'mercadolivre',
      ok: false,
      skipped: true,
      reason: 'not_connected',
      items: [],
    };
  }

  const url = new URL('https://api.mercadolibre.com/sites/MLB/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      source: 'mercadolivre',
      ok: false,
      status: response.status,
      reason: data.error || data.message || 'request_failed',
      items: [],
    };
  }

  const items = (Array.isArray(data.results) ? data.results : []).map((item) => ({
    source: 'mercadolivre',
    external_id: item.id || null,
    title: item.title || '',
    platform: 'Mercado Livre',
    url: item.permalink || null,
    image_url: item.thumbnail || item.secure_thumbnail || null,
    price: item.price == null ? null : Number(item.price),
    currency: item.currency_id || 'BRL',
  }));

  return {
    source: 'mercadolivre',
    ok: true,
    items,
  };
}

module.exports = { searchMercadoLivre };
