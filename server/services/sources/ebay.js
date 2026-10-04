const tokenCache = new Map();

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

  const response = await fetch(
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

function normalizeItems(data, searchQuery = null) {
  return (
    Array.isArray(data.itemSummaries) ? data.itemSummaries : []
  ).map((item) => ({
    source: "ebay",
    external_id: item.itemId || null,
    title: item.title || "",
    platform: "eBay",
    url: item.itemWebUrl || null,
    image_url:
      item.image?.imageUrl ||
      item.thumbnailImages?.[0]?.imageUrl ||
      null,
    price:
      item.price?.value == null
        ? null
        : Number(item.price.value),
    currency: item.price?.currency || null,
    search_query: searchQuery,
    item_end_date: item.itemEndDate || null,
    condition: item.condition || null,
  }));
}

async function requestBrowse(
  url,
  accessToken,
  marketplaceId,
  options = {},
) {
  const response = await fetch(url, {
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

function buildEbayQueries(query, maxQueries = 6) {
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
    const itemsByKey = new Map();
    const modes = [];
    const errors = [];

    for (const result of settled) {
      if (result.status === "rejected") {
        errors.push(
          result.reason?.message || String(result.reason),
        );
        continue;
      }

      modes.push(result.value.mode);

      for (const item of normalizeItems(
        result.value.data,
        result.value.query,
      )) {
        const key =
          item.external_id ||
          item.url ||
          `${item.title}|${item.price}`;

        if (!itemsByKey.has(key)) {
          itemsByKey.set(key, item);
        }
      }
    }

    if (!itemsByKey.size && errors.length) {
      return {
        source: "ebay",
        ok: false,
        status: 502,
        reason: errors.join(" | "),
        marketplace_id: config.marketplaceId,
        items: [],
      };
    }

    return {
      source: "ebay",
      ok: true,
      modes: [...new Set(modes)],
      queries,
      marketplace_id: config.marketplaceId,
      image_search_supported: imageSupported,
      partial_errors: errors,
      items: [...itemsByKey.values()].slice(
        0,
        Math.max(Number(limit || 50), 1),
      ),
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
