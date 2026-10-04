const { searchMercadoLivre, checkMercadoLivreListing } = require('./mercadolivre');
const {
  searchEbay,
  checkEbayListing,
  validateEbayCredentials,
  getEbayStatus,
} = require('./ebay');
const { searchOlx, getOlxStatus } = require('./olx');
const { getDepopStatus } = require('./depop');

async function searchAllSources({
  query,
  mercadoLivreAccessToken,
  ebayCredentials = null,
  referenceImageBuffer = null,
  limit = 50,
}) {
  const sourceNames = [
    "mercadolivre",
    "ebay",
    "olx",
  ];

  const settled = await Promise.allSettled([
    searchMercadoLivre({
      query,
      accessToken: mercadoLivreAccessToken,
      limit,
    }),
    searchEbay({
      query,
      limit,
      referenceImageBuffer,
      credentials: ebayCredentials,
    }),
    searchOlx({ query, limit }),
  ]);

  return settled.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    return {
      source: sourceNames[index],
      ok: false,
      skipped: false,
      reason:
        result.reason?.message ||
        String(result.reason || "source_failed"),
      items: [],
    };
  });
}

async function checkListingAvailability({
  sourceKey,
  externalId,
  mercadoLivreAccessToken,
  ebayCredentials = null,
}) {
  if (sourceKey === "mercadolivre") {
    return checkMercadoLivreListing({
      externalId,
      accessToken: mercadoLivreAccessToken,
    });
  }

  if (sourceKey === "ebay") {
    return checkEbayListing({
      externalId,
      credentials: ebayCredentials,
    });
  }

  return {
    ok: false,
    verifiable: false,
    reason: "source_not_verifiable",
  };
}

module.exports = {
  searchAllSources,
  checkListingAvailability,
  validateEbayCredentials,
  getEbayStatus,
  getOlxStatus,
  getDepopStatus,
};
