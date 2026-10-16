(() => {
  const profiles = [
    {key:'olx', name:'OLX', hosts:['olx.com.br']},
    {key:'shopee', name:'Shopee', hosts:['shopee.com.br']},
    {key:'repassa', name:'Repassa', hosts:['repassa.com.br']},
    {key:'ebrecho', name:'eBrecho', hosts:['ebrecho.com.br']},
    {key:'enjoei', name:'Enjoei', hosts:['enjoei.com.br']},
    {key:'mercadolivre', name:'Mercado Livre', hosts:['mercadolivre.com.br']},
    {key:'mercadolibre', name:'Mercado Libre', hosts:['mercadolibre.com','mercadolibre.com.ar','mercadolibre.com.mx','mercadolibre.cl','mercadolibre.com.co']},
    {key:'depop', name:'Depop', hosts:['depop.com']},
    {key:'ebay', name:'eBay', hosts:['ebay.com','ebay.co.uk','ebay.de']},
    {key:'facebook', name:'Facebook Marketplace', hosts:['facebook.com']},
    {key:'mercari', name:'Mercari', hosts:['mercari.com']},
    {key:'vinted', name:'Vinted', hosts:['vinted.com','vinted.fr','vinted.pt','vinted.es','vinted.de','vinted.it','vinted.co.uk']},
    {key:'grailed', name:'Grailed', hosts:['grailed.com']},
    {key:'poshmark', name:'Poshmark', hosts:['poshmark.com','poshmark.ca']},
  ];
  function profile(host) {
    host = String(host || '').toLowerCase();
    return profiles.find(p => p.hosts.some(h => host === h || host.endsWith('.' + h))) ||
      {key:host, name:host.replace(/^www\./,''), hosts:[host], generic:true};
  }
  function safeSearchUrl(raw) {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
          !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return null;
      if (/\/(?:login|signin|sign-in|auth|oauth|checkout|account|settings)(?:\/|$)/i.test(url.pathname)) return null;
      for (const key of url.searchParams.keys()) {
        if (/^(?:access_token|token|session|sessionid|password|auth|code|key|secret)$/i.test(key)) return null;
        if (/^(?:utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
      }
      url.hash = '';
      return url.href.length <= 2400 ? url.href : null;
    } catch { return null; }
  }
  function originPattern(raw) {
    const safe = safeSearchUrl(raw);
    return safe ? new URL(safe).origin + '/*' : null;
  }
  const api = {profiles, profile, safeSearchUrl, originPattern};
  globalThis.RadarSites = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
