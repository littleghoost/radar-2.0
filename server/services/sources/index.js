const { searchMercadoLivre } = require('./mercadolivre');
const { searchEbay, getEbayStatus } = require('./ebay');
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

module.exports = {
  searchAllSources,
  getEbayStatus,
  getOlxStatus,
  getDepopStatus,
};
