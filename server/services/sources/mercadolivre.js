function buildQueryVariants(query, maxVariants = 6) {
  const explicit = String(query || "")
    .split("|")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (explicit.length > 1) {
    return [...new Set(explicit)].slice(0, maxVariants);
  }

  const clean = explicit[0] || "";
  if (!clean) return [];

  const words = clean.split(/\s+/).filter(Boolean);

  if (words.length <= 4) {
    return [clean];
  }

  const anchors = words.slice(0, 2);
  const featureWords = words.slice(2).filter((word) =>
    /\d|nightshot|hdd|noturna|vis[aã]o|vintage|rara|rare|mini.?dv|hi8|digital8/i.test(
      word,
    ),
  );

  const variants = [
    clean,
    [...anchors, ...words.slice(2, 4)].join(" "),
    ...featureWords.map((feature) => [...anchors, feature].join(" ")),
  ];

  return [...new Set(variants.filter(Boolean))].slice(0, maxVariants);
}

async function searchMercadoLivre({ query, accessToken, limit = 50 }) {
  if (!accessToken) {
    return {
      source: "mercadolivre",
      ok: false,
      skipped: true,
      reason: "not_connected",
      items: [],
    };
  }

  const queries = buildQueryVariants(query);

  if (!queries.length) {
    return {
      source: "mercadolivre",
      ok: false,
      skipped: true,
      reason: "empty_query",
      items: [],
    };
  }

  const perQueryLimit = Math.min(
    50,
    Math.max(12, Math.ceil(Number(limit || 50) / queries.length) * 2),
  );

  const settled = await Promise.all(
    queries.map(async (searchQuery) => {
      const url = new URL(
        "https://api.mercadolibre.com/sites/MLB/search",
      );
      url.searchParams.set("q", searchQuery);
      url.searchParams.set("limit", String(perQueryLimit));

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        return {
          query: searchQuery,
          ok: false,
          status: response.status,
          reason:
            data.error ||
            data.message ||
            data.cause?.[0]?.message ||
            "request_failed",
          items: [],
        };
      }

      const items = (
        Array.isArray(data.results) ? data.results : []
      ).map((item) => ({
        source: "mercadolivre",
        external_id: item.id || null,
        title: item.title || "",
        platform: "Mercado Livre",
        url: item.permalink || null,
        image_url:
          item.secure_thumbnail ||
          item.thumbnail ||
          null,
        price: item.price == null ? null : Number(item.price),
        currency: item.currency_id || "BRL",
        search_query: searchQuery,
      }));

      return {
        query: searchQuery,
        ok: true,
        items,
      };
    }),
  );

  const deduped = new Map();

  for (const result of settled) {
    if (!result.ok) continue;

    for (const item of result.items) {
      const key = item.external_id || item.url;
      if (!key || deduped.has(key)) continue;
      deduped.set(key, item);
    }
  }

  const items = [...deduped.values()].slice(0, Number(limit || 50));
  const successful = settled.filter((result) => result.ok);
  const errors = settled
    .filter((result) => !result.ok)
    .map((result) => ({
      query: result.query,
      status: result.status || null,
      reason: result.reason || "request_failed",
    }));

  if (!successful.length) {
    const first = errors[0] || {};

    return {
      source: "mercadolivre",
      ok: false,
      status: first.status || null,
      reason: first.reason || "all_queries_failed",
      queries,
      errors,
      items: [],
    };
  }

  return {
    source: "mercadolivre",
    ok: true,
    queries,
    errors,
    items,
  };
}

async function checkMercadoLivreListing({
  externalId,
  accessToken,
}) {
  if (!externalId) {
    return {
      ok: false,
      verifiable: false,
      reason: "missing_external_id",
    };
  }

  if (!accessToken) {
    return {
      ok: false,
      verifiable: false,
      reason: "not_connected",
    };
  }

  const response = await fetch(
    `https://api.mercadolibre.com/items/${encodeURIComponent(externalId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
      reason:
        data.error ||
        data.message ||
        data.cause?.[0]?.message ||
        "request_failed",
      status: response.status,
    };
  }

  const rawStatus = String(data.status || "").toLowerCase();
  const available =
    rawStatus === "active" &&
    Number(data.available_quantity ?? 1) > 0;

  let detail = rawStatus || "unknown";

  if (
    rawStatus === "active" &&
    Number(data.available_quantity ?? 1) <= 0
  ) {
    detail = "out_of_stock";
  } else if (
    !available &&
    Number(data.sold_quantity || 0) > 0
  ) {
    detail = "closed_or_sold";
  }

  return {
    ok: true,
    verifiable: true,
    available,
    detail,
    raw_status: rawStatus || null,
    sold_quantity: Number(data.sold_quantity || 0),
    available_quantity:
      data.available_quantity == null
        ? null
        : Number(data.available_quantity),
    price: data.price == null ? null : Number(data.price),
    currency: data.currency_id || null,
  };
}

module.exports = {
  buildQueryVariants,
  searchMercadoLivre,
  checkMercadoLivreListing,
};
