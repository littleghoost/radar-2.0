function getDepopStatus() {
  const clientId = process.env.DEPOP_CLIENT_ID;
  const clientSecret = process.env.DEPOP_CLIENT_SECRET;
  const redirectUri = process.env.DEPOP_REDIRECT_URI;

  return {
    source: 'depop',
    configured: Boolean(clientId && clientSecret && redirectUri),
    access_required: true,
    mode: clientId && clientSecret && redirectUri ? 'credentials_ready' : 'partner_access_required',
    capabilities: {
      marketplace_search: false,
      seller_products: true,
      oauth: true,
    },
    note: 'A API oficial atual da Depop é voltada a parceiros/vendedores e não oferece busca geral do marketplace.',
  };
}

async function searchDepop() {
  return {
    source: 'depop',
    ok: false,
    skipped: true,
    reason: 'marketplace_search_unavailable',
    items: [],
  };
}

module.exports = { searchDepop, getDepopStatus };
