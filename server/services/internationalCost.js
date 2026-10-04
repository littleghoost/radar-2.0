let fxCache = {
  expiresAt: 0,
  rates: null,
  source: null,
};

function clampRate(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

async function getFxRates() {
  if (
    fxCache.rates &&
    fxCache.expiresAt > Date.now()
  ) {
    return {
      rates: fxCache.rates,
      source: fxCache.source,
      cached: true,
    };
  }

  const url =
    "https://economia.awesomeapi.com.br/json/last/" +
    "USD-BRL,EUR-BRL,GBP-BRL,JPY-BRL";

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    5000,
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.message ||
          `FX HTTP ${response.status}`,
      );
    }

    const rates = {
      BRL: 1,
      USD: Number(data.USDBRL?.bid),
      EUR: Number(data.EURBRL?.bid),
      GBP: Number(data.GBPBRL?.bid),
      JPY: Number(data.JPYBRL?.bid),
    };

    for (const [currency, rate] of Object.entries(rates)) {
      if (!Number.isFinite(rate) || rate <= 0) {
        if (currency === "BRL") continue;
        throw new Error(
          `Cotação ${currency}/BRL indisponível.`,
        );
      }
    }

    fxCache = {
      rates,
      source: "AwesomeAPI",
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
    };

    return {
      rates,
      source: fxCache.source,
      cached: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function convertToBrl(value, currency, rates) {
  const number = Number(value);

  if (!Number.isFinite(number)) return null;

  const code = String(currency || "BRL").toUpperCase();
  const rate = Number(rates?.[code]);

  if (!Number.isFinite(rate) || rate <= 0) {
    return null;
  }

  return number * rate;
}

function estimateBrazilImportCost({
  price,
  currency,
  shippingPrice = null,
  shippingCurrency = null,
  insuranceBrl = 0,
  settings = {},
  rates = {},
}) {
  const productBrl = convertToBrl(
    price,
    currency,
    rates,
  );

  if (!Number.isFinite(productBrl)) {
    return null;
  }

  const shippingKnown =
    shippingPrice !== null &&
    shippingPrice !== undefined &&
    Number.isFinite(Number(shippingPrice));

  const shippingBrl = shippingKnown
    ? convertToBrl(
        shippingPrice,
        shippingCurrency || currency,
        rates,
      )
    : 0;

  if (shippingKnown && !Number.isFinite(shippingBrl)) {
    return null;
  }

  const safeInsurance = Math.max(
    0,
    Number(insuranceBrl) || 0,
  );

  const customsValueBrl =
    productBrl +
    Number(shippingBrl || 0) +
    safeInsurance;

  const usdRate = Number(rates?.USD);
  const customsValueUsd =
    Number.isFinite(usdRate) && usdRate > 0
      ? customsValueBrl / usdRate
      : null;

  const program =
    settings.program === "prc"
      ? "prc"
      : "outside_prc";

  let importTaxBrl = 0;

  if (program === "prc") {
    if (
      Number.isFinite(customsValueUsd) &&
      customsValueUsd <= 50
    ) {
      importTaxBrl = 0;
    } else {
      const discountUsd = 30;
      const discountBrl =
        Number.isFinite(usdRate)
          ? discountUsd * usdRate
          : 0;

      importTaxBrl = Math.max(
        0,
        customsValueBrl * 0.6 - discountBrl,
      );
    }
  } else {
    importTaxBrl = customsValueBrl * 0.6;
  }

  const icmsRate = clampRate(
    Number(settings.icms_rate_percent ?? 20) / 100,
    0.2,
  );

  const icmsBase =
    customsValueBrl + importTaxBrl;

  const icmsBrl =
    icmsRate >= 1
      ? 0
      : (icmsBase / (1 - icmsRate)) * icmsRate;

  const handlingFeeBrl = Math.max(
    0,
    Number(settings.handling_fee_brl) || 0,
  );

  const totalBrl =
    customsValueBrl +
    importTaxBrl +
    icmsBrl +
    handlingFeeBrl;

  return {
    product_brl: Math.round(productBrl * 100) / 100,
    shipping_brl:
      Math.round(Number(shippingBrl || 0) * 100) / 100,
    shipping_known: shippingKnown,
    customs_value_brl:
      Math.round(customsValueBrl * 100) / 100,
    customs_value_usd:
      Number.isFinite(customsValueUsd)
        ? Math.round(customsValueUsd * 100) / 100
        : null,
    import_tax_brl:
      Math.round(importTaxBrl * 100) / 100,
    icms_brl:
      Math.round(icmsBrl * 100) / 100,
    handling_fee_brl:
      Math.round(handlingFeeBrl * 100) / 100,
    total_brl: Math.round(totalBrl * 100) / 100,
    icms_rate_percent:
      Math.round(icmsRate * 10000) / 100,
    program,
    estimate_kind: shippingKnown
      ? "landed_estimate"
      : "minimum_without_shipping",
  };
}

module.exports = {
  getFxRates,
  convertToBrl,
  estimateBrazilImportCost,
};
