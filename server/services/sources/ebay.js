const tokenCache = new Map();

const { sourceFetch } = require("./requestPolicy");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, attempts = 2) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // HTTP 403, 429 and Retry-After are handled by the shared request policy.
      // Never immediately retry an HTTP error: that amplifies rate limits.
      return await sourceFetch(url, options);
    } catch (error) {
      lastError = error;
      if (error.rateLimited || attempt >= attempts) throw error;
      await sleep(750 * attempt);
    }
  }

  throw lastError || new Error("Falha de rede no eBay.");
}

function normalizeCredentials(credentials = null) {
  const clientId =
    credentials?.clientId ||
    credentials?.client_id ||
    process.env.EBAY_CLIENT_ID ||
    null;
  const clientSecret =
    credentials?.clientSecret ||
    credentials?.client_secret ||
    process.env.EBAY_CLIENT_SECRET ||
    null;
  const marketplaceId =
    credentials?.marketplaceId ||
    credentials?.marketplace_id ||
    process.env.EBAY_MARKETPLACE_ID ||
    "EBAY_US";

  return {
    clientId: clientId ? String(clientId).trim() : null,
    clientSecret: clientSecret ? String(clientSecret).trim() : null,
    marketplaceId: String(marketplaceId || "EBAY_US").trim() || "EBAY_US",
  };
}

function credentialCacheKey(config) {
  return `${config.clientId || ""}:${config.marketplaceId}`;
}

async function getApplicationToken(credentials = null) {
  const config = normalizeCredentials(credentials);

  if (!config.clientId || !config.clientSecret) return null;

  const cacheKey = credentialCacheKey(config);
  const cached = tokenCache.get(cacheKey);

  if (cached && cached.expiresAt - Date.now() > 60_000) {
    return cached.accessToken;
  }

  const encoded = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
  ).toString("base64");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });

  const response = await fetchWithRetry(
    "https://api.ebay.com/identity/v1/oauth2/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${encoded}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    },
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.error_description ||
        data.error ||
        "Falha ao obter token de aplicação do eBay.",
    );
    error.status = response.status;
    throw error;
  }

  tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt:
      Date.now() + Number(data.expires_in || 0) * 1000,
  });

  return data.access_token;
}

function pickShippingOption(item = {}) {
  if (!Array.isArray(item.shippingOptions)) {
    return null;
  }

  return (
    item.shippingOptions.find(
      (option) =>
        option?.shippingCost?.value !== undefined,
    ) ||
    item.shippingOptions[0] ||
    null
  );
}

function normalizeItems(data, searchQuery = null) {
  return (
    Array.isArray(data.itemSummaries) ? data.itemSummaries : []
  ).map((item) => {
    const shippingOption = pickShippingOption(item);

    return {
    source: "ebay",
    external_id: item.itemId || null,
    title: item.title || "",
    platform: "eBay",
    url: item.itemWebUrl
      ? String(item.itemWebUrl).split("?")[0].split("#")[0]
      : null,
    image_url:
      item.image?.imageUrl ||
      item.thumbnailImages?.[0]?.imageUrl ||
      null,
    price:
      item.price?.value == null
        ? null
        : Number(item.price.value),
    currency: item.price?.currency || null,
    shipping_price:
      shippingOption?.shippingCost?.value == null
        ? null
        : Number(shippingOption.shippingCost.value),
    shipping_currency:
      shippingOption?.shippingCost?.currency ||
      item.price?.currency ||
      null,
    shipping_type:
      shippingOption?.type ||
      shippingOption?.shippingServiceCode ||
      null,
    search_query: searchQuery,
    item_end_date: item.itemEndDate || null,
    condition: item.condition || null,
    item_country: item.itemLocation?.country || null,
  };
  });
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

      const key =
        item.external_id ||
        item.url ||
        `${item.title}|${item.price}`;

      if (!key || seen.has(key)) continue;

      seen.add(key);
      output.push(item);

      if (output.length >= limit) break;
    }
  }

  return output;
}

async function requestBrowse(
  url,
  accessToken,
  marketplaceId,
  options = {},
) {
  const response = await fetchWithRetry(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
      accept: "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.errors?.[0]?.longMessage ||
        data.errors?.[0]?.message ||
        "request_failed",
    );
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}

function buildEndUserContext(destination = null) {
  const country = String(
    destination?.country || "",
  )
    .trim()
    .toUpperCase();

  if (!/^[A-Z]{2}$/.test(country)) {
    return null;
  }

  const postalCode = String(
    destination?.postalCode || "",
  )
    .trim()
    .replace(/[^0-9A-Za-z-]/g, "")
    .slice(0, 16);

  const parts = [`country=${country}`];

  if (postalCode) {
    parts.push(`zip=${postalCode}`);
  }

  return (
    "contextualLocation=" +
    encodeURIComponent(parts.join(","))
  );
}

async function enrichShippingDetails({
  items,
  accessToken,
  marketplaceId,
  browseHeaders,
  maxItems = 12,
}) {
  const candidates = (Array.isArray(items) ? items : [])
    .filter(
      (item) =>
        item?.external_id &&
        (item.shipping_price === null ||
          item.shipping_price === undefined),
    )
    .slice(0, Math.max(0, Number(maxItems) || 0));

  if (!candidates.length) {
    return {
      items,
      checked: 0,
      enriched: 0,
    };
  }

  const settled = await Promise.allSettled(
    candidates.map(async (item) => {
      const url =
        `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(item.external_id)}`;

      const detail = await requestBrowse(
        url,
        accessToken,
        marketplaceId,
        {
          headers: browseHeaders || {},
        },
      );

      const shippingOption =
        pickShippingOption(detail);

      return {
        external_id: item.external_id,
        shipping_price:
          shippingOption?.shippingCost?.value == null
            ? null
            : Number(
                shippingOption.shippingCost.value,
              ),
        shipping_currency:
          shippingOption?.shippingCost?.currency ||
          detail.price?.currency ||
          item.currency ||
          null,
        shipping_type:
          shippingOption?.type ||
          shippingOption?.shippingServiceCode ||
          null,
        item_country:
          detail.itemLocation?.country ||
          item.item_country ||
          null,
      };
    }),
  );

  const byId = new Map();
  let enriched = 0;

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;

    byId.set(
      result.value.external_id,
      result.value,
    );

    if (
      result.value.shipping_price !== null &&
      result.value.shipping_price !== undefined
    ) {
      enriched += 1;
    }
  }

  return {
    checked: candidates.length,
    enriched,
    items: items.map((item) => {
      const detail = byId.get(item.external_id);
      return detail
        ? {
            ...item,
            ...detail,
          }
        : item;
    }),
  };
}

function buildEbayQueries(query, maxQueries = 8) {
  const explicit = String(query || "")
    .split("|")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (explicit.length > 1) {
    return [...new Set(explicit)].slice(0, maxQueries);
  }

  const clean = explicit[0] || "";
  if (!clean) return [];

  return [clean];
}

async function validateEbayCredentials(credentials = null) {
  const config = normalizeCredentials(credentials);

  if (!config.clientId || !config.clientSecret) {
    return {
      ok: false,
      reason: "credentials_missing",
    };
  }

  try {
    await getApplicationToken(config);

    return {
      ok: true,
      marketplace_id: config.marketplaceId,
    };
  } catch (err) {
    return {
      ok: false,
      status: err.status || 500,
      reason: err.message,
    };
  }
}

async function searchEbay({
  query,
  limit = 50,
  referenceImageBuffer = null,
  credentials = null,
  destination = null,
}) {
  const config = normalizeCredentials(credentials);

  if (!config.clientId || !config.clientSecret) {
    return {
      source: "ebay",
      ok: false,
      skipped: true,
      reason: "credentials_pending",
      items: [],
    };
  }

  const queries = buildEbayQueries(query);

  if (!queries.length) {
    return {
      source: "ebay",
      ok: false,
      skipped: true,
      reason: "empty_query",
      items: [],
    };
  }

  try {
    const accessToken = await getApplicationToken(config);
    const endUserContext =
      buildEndUserContext(destination);
    const browseHeaders = endUserContext
      ? {
          "X-EBAY-C-ENDUSERCTX": endUserContext,
        }
      : {};
    const perQueryLimit = Math.min(
      200,
      Math.max(
        10,
        Math.ceil(Number(limit || 50) / queries.length) * 2,
      ),
    );

    const requests = queries.map((searchQuery) => {
      const url = new URL(
        "https://api.ebay.com/buy/browse/v1/item_summary/search",
      );
      url.searchParams.set("q", searchQuery);
      url.searchParams.set("limit", String(perQueryLimit));

      return requestBrowse(
        url,
        accessToken,
        config.marketplaceId,
        {
          headers: browseHeaders,
        },
      ).then((data) => ({
        mode: "keyword",
        query: searchQuery,
        data,
      }));
    });

    const imageSupported = [
      "EBAY_US",
      "EBAY_DE",
      "EBAY_GB",
      "EBAY_AU",
    ].includes(config.marketplaceId);

    if (referenceImageBuffer && imageSupported) {
      const imageUrl = new URL(
        "https://api.ebay.com/buy/browse/v1/item_summary/search_by_image",
      );
      imageUrl.searchParams.set(
        "limit",
        String(Math.min(200, Math.max(1, Number(limit || 50)))),
      );

      requests.push(
        requestBrowse(
          imageUrl,
          accessToken,
          config.marketplaceId,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...browseHeaders,
            },
            body: JSON.stringify({
              image: referenceImageBuffer.toString("base64"),
            }),
          },
        ).then((data) => ({
          mode: "image",
          query: null,
          data,
        })),
      );
    }

    const settled = await Promise.allSettled(requests);
    const itemGroups = [];
    const modes = [];
    const errors = [];
    const errorStatuses = [];

    for (const result of settled) {
      if (result.status === "rejected") {
        errors.push(
          result.reason?.message || String(result.reason),
        );
        errorStatuses.push(Number(result.reason?.status || 0));
        continue;
      }

      modes.push(result.value.mode);
      itemGroups.push(
        normalizeItems(
          result.value.data,
          result.value.query,
        ),
      );
    }

    const baseItems = roundRobinUniqueItems(
      itemGroups,
      Math.max(Number(limit || 50), 1),
    );

    if (!baseItems.length && errors.length) {
      return {
        source: "ebay",
        ok: false,
        status: errorStatuses.find((code) => [403, 429, 503].includes(code)) || 502,
        reason: [...new Set(errors)].slice(0, 3).join(" | "),
        marketplace_id: config.marketplaceId,
        items: [],
      };
    }

    const shippingEnrichment = endUserContext
      ? await enrichShippingDetails({
          items: baseItems,
          accessToken,
          marketplaceId: config.marketplaceId,
          browseHeaders,
          maxItems: 12,
        })
      : {
          items: baseItems,
          checked: 0,
          enriched: 0,
        };

    return {
      source: "ebay",
      ok: true,
      modes: [...new Set(modes)],
      queries,
      marketplace_id: config.marketplaceId,
      image_search_supported: imageSupported,
      partial_errors: errors,
      shipping_detail_checked:
        shippingEnrichment.checked,
      shipping_detail_enriched:
        shippingEnrichment.enriched,
      items: shippingEnrichment.items,
    };
  } catch (err) {
    return {
      source: "ebay",
      ok: false,
      status: err.status || 500,
      reason: err.message,
      marketplace_id: config.marketplaceId,
      items: [],
    };
  }
}

async function checkEbayListing({
  externalId,
  credentials = null,
}) {
  if (!externalId) {
    return {
      ok: false,
      verifiable: false,
      reason: "missing_external_id",
    };
  }

  const config = normalizeCredentials(credentials);

  if (!config.clientId || !config.clientSecret) {
    return {
      ok: false,
      verifiable: false,
      reason: "credentials_pending",
    };
  }

  try {
    const accessToken = await getApplicationToken(config);
    const url =
      `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(externalId)}`;
    const data = await requestBrowse(
      url,
      accessToken,
      config.marketplaceId,
    );

    const endTime = data.itemEndDate
      ? Date.parse(data.itemEndDate)
      : null;
    const ended =
      Number.isFinite(endTime) && endTime <= Date.now();

    return {
      ok: true,
      verifiable: true,
      available: !ended,
      detail: ended ? "ended" : "active",
      price:
        data.price?.value == null
          ? null
          : Number(data.price.value),
      currency: data.price?.currency || null,
      item_end_date: data.itemEndDate || null,
    };
  } catch (err) {
    if (err.status === 404 || err.status === 410) {
      return {
        ok: true,
        verifiable: true,
        available: false,
        detail: "item_not_found",
        status: err.status,
      };
    }

    return {
      ok: false,
      verifiable: true,
      reason: err.message,
      status: err.status || 500,
    };
  }
}

function getEbayStatus(credentials = null) {
  const config = normalizeCredentials(credentials);

  return {
    source: "ebay",
    configured: Boolean(
      config.clientId && config.clientSecret,
    ),
    marketplace_id: config.marketplaceId,
    keyword_search: true,
    image_search: [
      "EBAY_US",
      "EBAY_DE",
      "EBAY_GB",
      "EBAY_AU",
    ].includes(config.marketplaceId),
  };
}

module.exports = {
  buildEbayQueries,
  searchEbay,
  checkEbayListing,
  validateEbayCredentials,
  getEbayStatus,
};
