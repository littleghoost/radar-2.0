(() => {
  function detectPlatform(hostname) {
    const host = String(hostname || '').toLowerCase();
    const providers = [
      ['olx', 'OLX'],
      ['enjoei', 'Enjoei'],
      ['depop', 'Depop'],
      ['vinted', 'Vinted'],
      ['facebook', 'Facebook Marketplace'],
      ['ebay', 'eBay'],
      ['mercadolivre', 'Mercado Livre'],
      ['mercadolibre', 'Mercado Libre'],
    ];
    return providers.find(([needle]) => host.includes(needle))?.[1] || host.replace(/^www\./, '') || 'Navegador';
  }

  function absoluteUrl(value) {
    if (!value) return null;
    try {
      return new URL(value, location.href).href;
    } catch {
      return null;
    }
  }

  function cleanUrl(value) {
    try {
      const url = new URL(value);
      url.hash = '';
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid']
        .forEach((key) => url.searchParams.delete(key));
      return url.href;
    } catch {
      return value;
    }
  }

  function parsePrice(text) {
    const match = String(text || '').match(/(?:R\$|US\$|USD|EUR|€|GBP|£|\$)\s*([0-9][0-9.,\s]*)/i);
    if (!match) return { price: null, currency: 'BRL' };

    const prefix = match[0].slice(0, match[0].indexOf(match[1])).trim().toUpperCase();
    let raw = match[1].replace(/\s/g, '');
    const currency = prefix.includes('R$')
      ? 'BRL'
      : prefix.includes('€') || prefix.includes('EUR')
        ? 'EUR'
        : prefix.includes('£') || prefix.includes('GBP')
          ? 'GBP'
          : 'USD';

    if (currency === 'BRL' || currency === 'EUR') {
      if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
      else if ((raw.match(/\./g) || []).length > 1) raw = raw.replace(/\./g, '');
    } else if (raw.includes('.') && raw.includes(',')) {
      raw = raw.replace(/,/g, '');
    } else if ((raw.match(/,/g) || []).length === 1 && /,[0-9]{2}$/.test(raw)) {
      raw = raw.replace(',', '.');
    } else {
      raw = raw.replace(/,/g, '');
    }

    const number = Number(raw);
    return { price: Number.isFinite(number) ? number : null, currency };
  }

  function cardFor(anchor) {
    return anchor.closest(
      'article,li,[data-cy="l-card"],[data-testid="l-card"],[data-testid*="item"],[data-testid*="card"],[class*="listing"],[class*="product"],[class*="card"]',
    ) || anchor.parentElement || anchor;
  }

  function looksLikeListingUrl(url, platform) {
    try {
      const u = new URL(url);
      const path = u.pathname.toLowerCase();
      if (platform === 'OLX') return /\/d\/|\/item\/|\/anuncio\//.test(path) || /-[0-9]{6,}(?:\/|$)/.test(path);
      if (platform === 'Mercado Livre') return /\/mlb-?[0-9]+|\/p\/mlb/i.test(path);
      if (platform === 'eBay') return /\/itm\//.test(path);
      if (platform === 'Depop') return /\/products\//.test(path);
      if (platform === 'Vinted') return /\/items\//.test(path);
      return true;
    } catch { return false; }
  }

  function collectVisibleListings(limit = 100) {
    const platform = detectPlatform(location.hostname);
    const anchors = [...document.querySelectorAll('a[href]')];
    const seen = new Set();
    const items = [];

    for (const anchor of anchors) {
      if (items.length >= limit) break;

      const rawUrl = absoluteUrl(anchor.getAttribute('href'));
      const url = rawUrl ? cleanUrl(rawUrl) : null;
      if (!url || !/^https?:/i.test(url) || seen.has(url)) continue;
      if (!looksLikeListingUrl(url, platform)) continue;

      const card = cardFor(anchor);
      const rect = card.getBoundingClientRect?.();
      if (rect && rect.width === 0 && rect.height === 0) continue;

      const image = card.querySelector('img') || anchor.querySelector('img');
      if (!image) continue;

      const text = String(card.innerText || anchor.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length < 8) continue;

      const heading = card.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
      let title = String(
        heading?.innerText || image.alt || anchor.getAttribute('title') || anchor.innerText || text,
      ).replace(/\s+/g, ' ').trim();
      if (title.length > 180) title = title.slice(0, 180);
      if (title.length < 3) continue;

      const { price, currency } = parsePrice(text);
      if (platform === 'OLX' && price === null) continue;
      const imageUrl = absoluteUrl(
        image.currentSrc || image.src || image.getAttribute('data-src') || image.getAttribute('data-lazy-src'),
      );

      seen.add(url);
      items.push({
        title,
        platform,
        url,
        image_url: imageUrl,
        current_price: price,
        currency,
      });
    }

    return {
      version: 2,
      source_url: location.href,
      platform,
      captured_at: new Date().toISOString(),
      items,
    };
  }

  globalThis.__radarCollectVisibleListings = collectVisibleListings;
})();
