"use strict";
(() => {
  const terms = {
    roupas: [
      'JNCO', 'JNCO Kangaroo', 'JNCO Rhino', 'calça baggy vintage',
      'calça tribal', 'MCD Circo dos Horrores', 'Tapout', 'Southpole baggy',
      'Ecko bordada', 'jorts bordada', 'calça flare vintage',
    ],
    cameras: [
      'Sony Handycam DCR-SR', 'Sony Handycam NightShot',
      'filmadora Sony HDD', 'Sony DCR-SR47', 'Sony DCR-SR68',
      'filmadora NightShot HDD',
    ],
  };
  const sources = ['olx','enjoei','mercadolivre','facebook'];
  function buildUrl(source, query) {
    const term = String(query || '').trim();
    if (!term) return null;
    const encoded = encodeURIComponent(term);
    if (source === 'olx') return 'https://www.olx.com.br/brasil?q=' + encoded;
    if (source === 'enjoei') {
      const slug = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      return 'https://www.enjoei.com.br/' + slug + '/s?q=' + encoded;
    }
    if (source === 'mercadolivre') return 'https://lista.mercadolivre.com.br/' + encoded.replace(/%20/g,'-');
    if (source === 'facebook') return 'https://www.facebook.com/marketplace/search/?query=' + encoded;
    return null;
  }
  const api = {terms, sources, buildUrl};
  globalThis.RadarBrazilPresets = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
