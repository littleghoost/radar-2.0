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

async function checkMercadoLivreListing({ externalId, accessToken }) {
  if (!externalId) {
    return { ok: false, verifiable: false, reason: "missing_external_id" };
  }

  const response = await fetch(
    `https://api.mercadolibre.com/items/${encodeURIComponent(externalId)}`,
    {
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        accept: "application/json",
      },
    },
  );

  if (response.status === 404 || response.status === 410) {
    return {
      ok: true,
      verifiable: true,
      available: false,
      detail: "item_not_found",
      status: response.status,
    };
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      verifiable: true,
      reason: data.error || data.message || "request_failed",
      status: response.status,
    };
  }

  const rawStatus = String(data.status || "").toLowerCase();
  const available = rawStatus === "active";
  let detail = rawStatus || "unknown";

  if (!available && Number(data.sold_quantity || 0) > 0) {
    detail = "closed_or_sold";
  }

  return {
    ok: true,
    verifiable: true,
    available,
    detail,
    raw_status: rawStatus || null,
    sold_quantity: Number(data.sold_quantity || 0),
    price: data.price == null ? null : Number(data.price),
    currency: data.currency_id || null,
  };
}

module.exports = { searchMercadoLivre, checkMercadoLivreListing };
