function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url,
  options = {},
  attempts = 2,
) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);

      if (
        attempt < attempts &&
        [408, 425, 429, 500, 502, 503, 504].includes(
          response.status,
        )
      ) {
        await response
          .arrayBuffer()
          .catch(() => null);
        await sleep(350 * attempt);
        continue;
      }

      return response;
    } catch (err) {
      lastError = err;

      if (attempt >= attempts) {
        throw err;
      }

      await sleep(350 * attempt);
    }
  }

  throw lastError || new Error(
    "Falha de rede no Mercado Livre.",
  );
}

function buildQueryVariants(query, maxVariants = 8) {
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

function roundRobinUniqueItems(
  groups,
  limit = 50,
) {
  const output = [];
  const seen = new Set();
  const safeGroups = (groups || []).filter(
    (group) => Array.isArray(group) && group.length,
  );
  const maxLength = safeGroups.reduce(
    (max, group) => Math.max(max, group.length),
    0,
  );

  for (
    let row = 0;
    row < maxLength && output.length < limit;
    row += 1
  ) {
    for (const group of safeGroups) {
      const item = group[row];
      if (!item) continue;

      const key = item.external_id || item.url;
      if (!key || seen.has(key)) continue;

      seen.add(key);
      output.push(item);

      if (output.length >= limit) break;
    }
  }

  return output;
}

async function searchCatalogProducts({
  queries,
  accessToken,
  limit = 24,
}) {
  const perQueryLimit = Math.min(
    20,
    Math.max(5, Math.ceil(Number(limit || 24) / Math.max(queries.length, 1))),
  );

  const settled = await Promise.all(
    queries.map(async (searchQuery) => {
      const url = new URL(
        "https://api.mercadolibre.com/products/search",
      );
      url.searchParams.set("status", "active");
      url.searchParams.set("site_id", "MLB");
      url.searchParams.set("q", searchQuery);
      url.searchParams.set("limit", String(perQueryLimit));

      let response;

      try {
        response = await fetchWithRetry(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            accept: "application/json",
          },
        });
      } catch (err) {
        return {
          query: searchQuery,
          ok: false,
          status: null,
          reason:
            err.cause?.code ||
            err.message ||
            "catalog_network_failed",
          products: [],
        };
      }

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
            "catalog_request_failed",
          products: [],
        };
      }

      const products = (
        Array.isArray(data.results) ? data.results : []
      ).map((product) => ({
        source: "mercadolivre_catalog",
        external_id: product.id || null,
        title: product.name || "",
        url: product.id
          ? `https://www.mercadolivre.com.br/p/${encodeURIComponent(product.id)}`
          : null,
        image_url:
          product.pictures?.[0]?.url ||
          product.pictures?.[0]?.secure_url ||
          product.thumbnail ||
          null,
        product_status: product.status || "active",
        domain_id: product.domain_id || null,
        search_query: searchQuery,
        metadata: {
          listing_strategy:
            product.settings?.listing_strategy || null,
          main_features: Array.isArray(product.main_features)
            ? product.main_features.slice(0, 8)
            : [],
        },
      }));

      return {
        query: searchQuery,
        ok: true,
        products,
      };
    }),
  );

  const deduped = new Map();

  for (const result of settled) {
    if (!result.ok) continue;

    for (const product of result.products) {
      const key = product.external_id || product.url;
      if (!key || deduped.has(key)) continue;
      deduped.set(key, product);
    }
  }

  return {
    products: [...deduped.values()].slice(0, Number(limit || 24)),
    errors: settled
      .filter((result) => !result.ok)
      .map((result) => ({
        query: result.query,
        status: result.status || null,
        reason: result.reason || "catalog_request_failed",
      })),
  };
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

      let response;

      try {
        response = await fetchWithRetry(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            accept: "application/json",
          },
        });
      } catch (err) {
        return {
          query: searchQuery,
          ok: false,
          status: null,
          reason:
            err.cause?.code ||
            err.message ||
            "marketplace_network_failed",
          items: [],
        };
      }

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

  const itemGroups = settled
    .filter((result) => result.ok)
    .map((result) => result.items);

  const items = roundRobinUniqueItems(
    itemGroups,
    Math.max(Number(limit || 50), 1),
  );

  const successful = settled.filter((result) => result.ok);
  const errors = settled
    .filter((result) => !result.ok)
    .map((result) => ({
      query: result.query,
      status: result.status || null,
      reason: result.reason || "request_failed",
    }));

  let catalog = {
    products: [],
    errors: [],
  };

  if (!successful.length || items.length === 0) {
    catalog = await searchCatalogProducts({
      queries,
      accessToken,
      limit: Math.min(24, Number(limit || 50)),
    });
  }

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
      catalog_items: catalog.products,
      catalog_errors: catalog.errors,
      catalog_fallback: true,
    };
  }

  return {
    source: "mercadolivre",
    ok: true,
    queries,
    errors,
    items,
    catalog_items: catalog.products,
    catalog_errors: catalog.errors,
    catalog_fallback: catalog.products.length > 0,
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

  const response = await fetchWithRetry(
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
