const { searchMercadoLivre, checkMercadoLivreListing } = require('./mercadolivre');
const { searchEbay, checkEbayListing, getEbayStatus } = require('./ebay');
const { searchOlx, getOlxStatus } = require('./olx');
const { getDepopStatus } = require('./depop');

async function searchAllSources({ query, mercadoLivreAccessToken, referenceImageBuffer = null, limit = 50 }) {
  const results = await Promise.all([
    searchMercadoLivre({ query, accessToken: mercadoLivreAccessToken, limit }),
    searchEbay({ query, limit, referenceImageBuffer }),
    searchOlx({ query, limit }),
  ]);

  return results;
}

async function checkListingAvailability({ sourceKey, externalId, mercadoLivreAccessToken }) {
  if (sourceKey === "mercadolivre") {
    return checkMercadoLivreListing({
      externalId,
      accessToken: mercadoLivreAccessToken,
    });
  }

  if (sourceKey === "ebay") {
    return checkEbayListing({ externalId });
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
  getEbayStatus,
  getOlxStatus,
  getDepopStatus,
};
