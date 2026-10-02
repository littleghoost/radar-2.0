function getOlxStatus() {
  const clientId = process.env.OLX_CLIENT_ID;
  const clientSecret = process.env.OLX_CLIENT_SECRET;
  const redirectUri = process.env.OLX_REDIRECT_URI;

  return {
    source: 'olx',
    configured: Boolean(clientId && clientSecret && redirectUri),
    homologation_required: true,
    mode: clientId && clientSecret && redirectUri ? 'credentials_ready' : 'pending_homologation',
  };
}

async function searchOlx() {
  const status = getOlxStatus();

  // A OLX disponibiliza integração oficial mediante homologação. Enquanto o
  // acesso do Radar não estiver aprovado, esta fonte fica explicitamente
  // desativada em vez de recorrer a scraping/bypass.
  return {
    source: 'olx',
    ok: false,
    skipped: true,
    reason: status.configured ? 'integration_not_enabled' : 'pending_homologation',
    items: [],
  };
}

module.exports = { searchOlx, getOlxStatus };
