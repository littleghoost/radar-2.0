(() => {
  if (globalThis.__radarCollectorLoaded) {
    return;
  }

  globalThis.__radarCollectorLoaded = true;

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
      if (raw.includes(',')) {
        raw = raw.replace(/\./g, '').replace(',', '.');
      } else if (/^\d{1,3}(?:\.\d{3})+$/.test(raw)) {
        raw = raw.replace(/\./g, '');
      }
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

  function listingIdentity(url, platform) {
    try {
      const u = new URL(url);
      const path = u.pathname;

      if (platform === 'OLX') {
        const match = path.match(/-(\d{8,})(?:\/)?$/);
        return match ? `olx:${match[1]}` : cleanUrl(u.href);
      }

      if (platform === 'Mercado Livre' || platform === 'Mercado Libre') {
        const match = u.href.toUpperCase().match(/MLB-?(\d{6,})/);
        return match ? `mlb:${match[1]}` : cleanUrl(u.href);
      }

      if (platform === 'eBay') {
        const match = path.match(/\/itm\/(?:[^/]+\/)?(\d{8,})/i);
        return match ? `ebay:${match[1]}` : cleanUrl(u.href);
      }

      if (platform === 'Depop') {
        const match = path.match(/\/products\/([^/?#]+)/i);
        return match ? `depop:${match[1].toLowerCase()}` : cleanUrl(u.href);
      }

      if (platform === 'Enjoei') {
        const match =
          path.match(/\/p\/[^/?#]*-(\d{6,})(?:\/)?$/i) ||
          path.match(/(?:^|[-/])(\d{6,})(?:\/)?$/i);
        return match ? `enjoei:${match[1]}` : cleanUrl(u.href);
      }

      if (platform === 'Facebook Marketplace') {
        const match = path.match(/\/marketplace\/item\/(\d+)/i);
        return match ? `facebook:${match[1]}` : cleanUrl(u.href);
      }

      return cleanUrl(u.href);
    } catch {
      return String(url || '');
    }
  }

  function olxCardFor(anchor, anchorUrl) {
    const anchorIdentity = listingIdentity(anchorUrl, 'OLX');

    for (
      let node = anchor;
      node && node !== document.body && node !== document.documentElement;
      node = node.parentElement
    ) {
      const text = String(node.innerText || '')
        .replace(/\s+/g, ' ')
        .trim();

      if (text.length > 1200) {
        break;
      }

      const imageCount = node.querySelectorAll?.('img')?.length || 0;
      if (!imageCount || imageCount > 6 || !/R\$\s*\d/.test(text)) {
        continue;
      }

      const listingIdentities = new Set(
        [...(node.querySelectorAll?.('a[href]') || [])]
          .map((link) => absoluteUrl(link.getAttribute('href')))
          .filter(Boolean)
          .filter((href) => looksLikeListingUrl(href, 'OLX'))
          .map((href) => listingIdentity(href, 'OLX')),
      );

      if (
        listingIdentities.size === 1 &&
        listingIdentities.has(anchorIdentity)
      ) {
        return node;
      }
    }

    return null;
  }

  function olxTitleMatchesUrl(title, url) {
    try {
      const path = new URL(url).pathname;
      const match = path.match(/\/([^/]+)-(\d{8,})(?:\/)?$/);

      if (!match) return true;

      const ignored = new Set([
        'sony',
        'handycam',
        'filmadora',
        'camera',
        'cameras',
        'modelo',
        'original',
        'usada',
        'usado',
      ]);

      const words = (value) =>
        new Set(
          String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim()
            .split(/\s+/)
            .filter((word) => word.length >= 3 && !ignored.has(word)),
        );

      const titleWords = words(title);
      const slugWords = words(match[1]);

      if (!titleWords.size || !slugWords.size) {
        return true;
      }

      let shared = 0;

      for (const word of titleWords) {
        if (slugWords.has(word)) shared += 1;
      }

      return shared >= 1;
    } catch {
      return true;
    }
  }

  function isolatedCardFor(anchor, platform, anchorUrl) {
    const anchorIdentity = listingIdentity(anchorUrl, platform);

    for (
      let node = anchor;
      node && node !== document.body && node !== document.documentElement;
      node = node.parentElement
    ) {
      const text = String(node.innerText || '')
        .replace(/\s+/g, ' ')
        .trim();

      if (text.length > 1600) {
        break;
      }

      const images = node.querySelectorAll?.('img')?.length || 0;
      if (!images || images > 8) continue;
      if (!/(?:R\$|US\$|USD|EUR|€|GBP|£|\$)\s*\d/i.test(text)) continue;

      const identities = new Set(
        [...(node.querySelectorAll?.('a[href]') || [])]
          .map((link) => absoluteUrl(link.getAttribute('href')))
          .filter(Boolean)
          .filter((href) => looksLikeListingUrl(href, platform))
          .map((href) => listingIdentity(href, platform)),
      );

      if (
        identities.size === 1 &&
        identities.has(anchorIdentity)
      ) {
        return node;
      }
    }

    return null;
  }

  function cardFor(anchor, platform, anchorUrl) {
    if (platform === 'OLX') {
      return olxCardFor(anchor, anchorUrl);
    }

    if (
      platform === 'Enjoei' ||
      platform === 'Facebook Marketplace'
    ) {
      return isolatedCardFor(anchor, platform, anchorUrl);
    }

    const direct = anchor.closest(
      'article,li,[data-cy="l-card"],[data-testid="l-card"],[data-testid*="item"],[data-testid*="card"],[class*="listing"],[class*="product"],[class*="card"]',
    );
    return direct || anchor.parentElement || anchor;
  }

  function looksLikeListingUrl(url, platform) {
    try {
      const u = new URL(url);
      const path = u.pathname.toLowerCase();
      if (platform === 'OLX') return /\/d\/|\/item\/|\/anuncio\//.test(path) || /-[0-9]{6,}(?:\/|$)/.test(path);
      if (platform === 'Mercado Livre') return /\/mlb-?[0-9]+|\/p\/mlb/i.test(path);
      if (platform === 'eBay') return /\/itm\//.test(path);
      if (platform === 'Depop') return /\/products\//.test(path);
      if (platform === 'Enjoei') return /\/p\/[^/]+-\d{6,}(?:\/|$)/.test(path);
      if (platform === 'Facebook Marketplace') return /\/marketplace\/item\/\d+/.test(path);
      if (platform === 'Vinted') return /\/items\//.test(path);
      return true;
    } catch { return false; }
  }

  function slugifyEnjoeiTitle(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
  }

  function enjoeiProductUrlFromCard(card, title = '') {
    const links = [
      ...(card.matches?.('a[href]') ? [card] : []),
      ...card.querySelectorAll('a[href]'),
    ];

    for (const link of links) {
      const candidate = absoluteUrl(
        link.getAttribute('href'),
      );
      if (
        candidate &&
        looksLikeListingUrl(candidate, 'Enjoei')
      ) {
        return cleanUrl(candidate);
      }
    }

    const html = String(card.outerHTML || '');
    const embedded = html.match(
      /(?:https?:\/\/www\.enjoei\.com\.br)?(\/p\/[^"'<>\\s]+-\d{6,})(?:[?"'<>\\s]|$)/i,
    );
    if (embedded?.[1]) {
      return cleanUrl(
        absoluteUrl(embedded[1]),
      );
    }

    const idMatch = html.match(
      /(?:product[-_]?id|productId)[^0-9]{0,30}(\d{6,})/i,
    );
    const slug = slugifyEnjoeiTitle(title);
    if (idMatch?.[1] && slug) {
      return `https://www.enjoei.com.br/p/${slug}-${idMatch[1]}`;
    }

    return null;
  }

  function collectEnjoeiProductCards(limit, diagnostics) {
    const cards = [
      ...document.querySelectorAll(
        '.c-product-card, [class*="c-product-card"]:not(.c-content-placeholder), [class*="product-card"]:not(.c-content-placeholder)',
      ),
    ].filter(
      (card, index, all) =>
        all.indexOf(card) === index &&
        !card.classList?.contains(
          'c-content-placeholder',
        ),
    );
    diagnostics.enjoeiCards = cards.length;

    const seen = new Set();
    const items = [];

    for (const card of cards) {
      if (items.length >= limit) break;

      const rect = card.getBoundingClientRect?.();
      if (rect && rect.width === 0 && rect.height === 0) continue;
      diagnostics.passedVisible += 1;

      const image = card.querySelector('img');
      if (!image) continue;
      diagnostics.passedImage += 1;

      const text = String(card.innerText || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length < 8 || !/R\$\s*\d/.test(text)) continue;
      diagnostics.passedText += 1;

      const heading = card.querySelector(
        'h1,h2,h3,h4,h5,h6,[role="heading"]',
      );
      let title = String(
        heading?.innerText ||
          image.alt ||
          text,
      )
        .replace(/\s+/g, ' ')
        .trim();

      if (title.length > 180) title = title.slice(0, 180);
      if (title.length < 3) continue;
      diagnostics.passedTitle += 1;

      const url = enjoeiProductUrlFromCard(
        card,
        title,
      );
      if (
        !url ||
        !/^https?:/i.test(url) ||
        !looksLikeListingUrl(url, 'Enjoei')
      ) {
        continue;
      }

      const identity = listingIdentity(url, 'Enjoei');
      if (
        !identity ||
        seen.has(identity)
      ) {
        continue;
      }
      diagnostics.passedUrl += 1;

      const { price, currency } = parsePrice(text);
      const imageUrl = absoluteUrl(
        image.currentSrc ||
          image.src ||
          image.getAttribute('data-src') ||
          image.getAttribute('data-lazy-src'),
      );

      seen.add(identity);
      items.push({
        title,
        platform: 'Enjoei',
        url,
        image_url: imageUrl,
        current_price: price,
        currency,
      });
    }

    return items;
  }

  function collectVisibleListings(limit = 100) {
    const platform = detectPlatform(location.hostname);
    const anchors = [...document.querySelectorAll('a[href]')];
    const diagnostics = {
      anchors: anchors.length,
      olxCards: document.querySelectorAll('[data-cy="l-card"], [data-testid="l-card"], article').length,
      images: document.querySelectorAll('img').length,
      priceTexts: [...document.querySelectorAll('body *')].filter((el) => /R\$\s*\d/.test(el.textContent || '')).length,
      listingUrls: anchors.filter((a) => { try { return looksLikeListingUrl(new URL(a.href, location.href).href, platform); } catch { return false; } }).length,
      passedUrl: 0,
      passedVisible: 0,
      passedImage: 0,
      passedText: 0,
      passedTitle: 0,
    };
    const seen = new Set();
    const items = [];

    if (platform === 'Enjoei') {
      const enjoeiItems = collectEnjoeiProductCards(limit, diagnostics);
      if (enjoeiItems.length) {
        return {
          version: 8,
          source_url: location.href,
          platform,
          captured_at: new Date().toISOString(),
          items: enjoeiItems,
          diagnostics,
        };
      }
    }

    for (const anchor of anchors) {
      if (items.length >= limit) break;

      const rawUrl = absoluteUrl(anchor.getAttribute('href'));
      const url = rawUrl ? cleanUrl(rawUrl) : null;
      if (!url || !/^https?:/i.test(url)) continue;
      if (!looksLikeListingUrl(url, platform)) continue;

      const identity = listingIdentity(url, platform);
      if (!identity || seen.has(identity)) continue;
      diagnostics.passedUrl += 1;

      const card = cardFor(anchor, platform, url);
      if (!card) continue;
      const rect = card.getBoundingClientRect?.();
      if (rect && rect.width === 0 && rect.height === 0) continue;
      diagnostics.passedVisible += 1;

      const image = card.querySelector('img') || anchor.querySelector('img');
      if (!image) continue;
      diagnostics.passedImage += 1;

      const text = String(card.innerText || anchor.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length < 8) continue;
      diagnostics.passedText += 1;

      const heading = card.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
      let title = String(
        heading?.innerText || image.alt || anchor.getAttribute('title') || anchor.innerText || text,
      ).replace(/\s+/g, ' ').trim();
      if (title.length > 180) title = title.slice(0, 180);
      if (title.length < 3) continue;

      if (
        platform === 'OLX' &&
        !olxTitleMatchesUrl(title, url)
      ) {
        continue;
      }

      diagnostics.passedTitle += 1;

      const { price, currency } = parsePrice(text);
      const imageUrl = absoluteUrl(
        image.currentSrc || image.src || image.getAttribute('data-src') || image.getAttribute('data-lazy-src'),
      );

      seen.add(identity);
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
      version: 8,
      source_url: location.href,
      platform,
      captured_at: new Date().toISOString(),
      items,
      diagnostics,
    };
  }

  globalThis.__radarCollectVisibleListings = collectVisibleListings;

  chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
      if (message?.type !== 'radar-collect-now') {
        return false;
      }

      try {
        sendResponse({
          ok: true,
          capture: collectVisibleListings(
            Number(message.limit || 100),
          ),
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error:
            error?.message || String(error),
        });
      }

      return false;
    },
  );

  const autoPlatforms = new Set([
    'OLX',
    'Enjoei',
    'Facebook Marketplace',
    'Mercado Livre',
    'Mercado Libre',
    'eBay',
    'Depop',
  ]);

  let autoTimer = null;
  let lastAutoFingerprint = '';
  let lastAutoSentAt = 0;

  function captureFingerprint(capture) {
    return capture.items
      .map((item) => `${item.url}:${item.current_price ?? ''}`)
      .sort()
      .join('|');
  }

  async function runAutoCapture() {
    if (!autoPlatforms.has(detectPlatform(location.hostname))) {
      return;
    }

    if (document.visibilityState !== 'visible') {
      return;
    }

    const stored = await chrome.storage.local.get({
      autoCaptureEnabled: true,
    });

    if (!stored.autoCaptureEnabled) {
      return;
    }

    const capture = collectVisibleListings(100);

    if (!capture.items.length) {
      return;
    }

    const fingerprint = captureFingerprint(capture);
    const now = Date.now();

    if (
      fingerprint === lastAutoFingerprint ||
      now - lastAutoSentAt < 15_000
    ) {
      return;
    }

    lastAutoFingerprint = fingerprint;
    lastAutoSentAt = now;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'radar-auto-capture',
        capture,
      });

      if (!response?.ok) {
        lastAutoFingerprint = '';
      }
    } catch {
      // O Radar pode estar fechado; a próxima alteração da página tenta novamente.
      lastAutoFingerprint = '';
    }
  }

  function scheduleAutoCapture(delay = 3500) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      runAutoCapture().catch(() => {});
    }, delay);
  }

  const observer = new MutationObserver(() => {
    scheduleAutoCapture(4500);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  addEventListener(
    'scroll',
    () => {
      scheduleAutoCapture(3000);
    },
    { passive: true },
  );

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleAutoCapture(1200);
    }
  });

  scheduleAutoCapture(2500);
})();
