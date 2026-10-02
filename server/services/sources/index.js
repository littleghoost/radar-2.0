const { searchMercadoLivre } = require('./mercadolivre');
const { searchEbay, getEbayStatus } = require('./ebay');

async function searchAllSources({ query, mercadoLivreAccessToken, limit = 50 }) {
  const results = await Promise.all([
    searchMercadoLivre({ query, accessToken: mercadoLivreAccessToken, limit }),
    searchEbay({ query, limit }),
  ]);

  return results;
}

module.exports = {
  searchAllSources,
  getEbayStatus,
};
