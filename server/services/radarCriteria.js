const DEFAULT_STOPWORDS = new Set([
  "para", "com", "sem", "por", "uma", "umas", "uns", "das", "dos",
  "de", "da", "do", "em", "no", "na", "nos", "nas", "e", "ou",
  "the", "and", "for", "with", "from", "a", "an", "of", "to",
]);

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter(
      (word) =>
        word.length >= 2 &&
        !DEFAULT_STOPWORDS.has(word),
    );
}

function parseTerms(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .map((term) => String(term || "").trim())
          .filter(Boolean),
      ),
    ];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) return [];

    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parseTerms(parsed);
      } catch {
        // cai para o parser de texto simples
      }
    }

    return [
      ...new Set(
        trimmed
          .split(/[\n,;]+/)
          .map((term) => term.trim())
          .filter(Boolean),
      ),
    ];
  }

  return [];
}

function termsJson(value) {
  return JSON.stringify(parseTerms(value));
}

function termMatches(normalizedHaystack, tokenSet, term) {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;

  if (normalizedTerm.includes(" ")) {
    return normalizedHaystack.includes(normalizedTerm);
  }

  return tokenSet.has(normalizedTerm);
}

function queryMetrics(query, normalizedHaystack, tokenSet) {
  const variants = String(query || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  if (!variants.length) {
    return {
      fit: 0,
      hits: 0,
      strongHits: 0,
      weightedHits: 0,
      variant: null,
      matched: [],
    };
  }

  let best = null;

  for (const variant of variants) {
    const words = [...new Set(tokenize(variant))];

    if (!words.length) continue;

    let matchedWeight = 0;
    let totalWeight = 0;
    let hits = 0;
    let strongHits = 0;
    const matched = [];

    for (const word of words) {
      const modelLike = /\d/.test(word);
      const weight = modelLike ? 1.65 : 1;
      totalWeight += weight;

      if (!tokenSet.has(word)) continue;

      hits += 1;
      matchedWeight += weight;
      matched.push(word);

      if (modelLike) strongHits += 1;
    }

    const fit = totalWeight
      ? matchedWeight / totalWeight
      : 0;

    const result = {
      fit,
      hits,
      strongHits,
      weightedHits: matchedWeight,
      variant,
      matched,
    };

    if (!best || result.fit > best.fit) {
      best = result;
    }
  }

  return (
    best || {
      fit: 0,
      hits: 0,
      strongHits: 0,
      weightedHits: 0,
      variant: null,
      matched: [],
    }
  );
}

function radarCriteriaConfig(radar = {}) {
  return {
    priorityTerms: parseTerms(
      radar.priority_terms_json ??
        radar.priority_terms,
    ),
    penalizedTerms: parseTerms(
      radar.penalized_terms_json ??
        radar.penalized_terms,
    ),
    requiredTerms: parseTerms(
      radar.required_terms_json ??
        radar.required_terms,
    ),
    excludeTerms: parseTerms(
      radar.exclude_terms_json ??
        radar.exclude_terms,
    ),
    criteriaWeight: Math.max(
      0,
      Math.min(
        100,
        Number(radar.criteria_weight ?? 65) || 65,
      ),
    ),
    budgetCurrency: String(
      radar.budget_currency || "BRL",
    ).toUpperCase(),
  };
}

function automaticCategoryGuard(radar = {}, listing = {}) {
  const category = normalizeText(radar.category || "");
  const title = normalizeText(listing.title || "");

  if (!title) {
    return {
      rejected: false,
      penalty: 0,
      reasons: [],
    };
  }

  if (
    category.includes("camera") ||
    category.includes("filmadora")
  ) {
    const hardAccessoryPatterns = [
      /\bdcra[- ]?[a-z0-9]+\b/,
      /\bdocking station\b/,
      /\bcamcorder station\b/,
      /\bhandycam station\b/,
      /\bstation dock\b/,
      /\bdock(?:ing)?\b.*\bfor\b/,
      /\bbase de carregamento\b/,
      /^(?:sony\s+)?(?:handycam\s+)?(?:carrying\s+)?(?:case|bag)\b/,
      /^bolsa\b/,
      /\b(?:carrying|transport)\s+(?:case|bag)\b/,
      /\b(?:case|bag)\b.*\bfor\b.*\b(?:sony|handycam|camcorder|camera|dcr|hdr)\b/,
      /\bbolsa\b.*\bpara\b.*\b(?:sony|handycam|camera|filmadora)\b/,
      /\bservice manual\b/,
      /\bmanual de servico\b/,
    ];

    const accessoryForPatterns = [
      /\bcharger\b.*\bfor\b/,
      /\bbattery\b.*\bfor\b/,
      /\bcase\b.*\bfor\b/,
      /\bcable\b.*\bfor\b/,
      /\bac adapter\b.*\bfor\b/,
      /\bpower supply\b.*\bfor\b/,
      /\breplacement\b.*\bfor\b/,
      /\bcarregador\b.*\bpara\b/,
      /\bbateria\b.*\bpara\b/,
      /\bcabo\b.*\bpara\b/,
      /\badaptador\b.*\bpara\b/,
    ];

    if (
      hardAccessoryPatterns.some((pattern) =>
        pattern.test(title),
      ) ||
      accessoryForPatterns.some((pattern) =>
        pattern.test(title),
      )
    ) {
      return {
        rejected: true,
        penalty: 100,
        reasons: [
          "acessório de câmera identificado automaticamente",
        ],
      };
    }

    const softAccessoryTerms = [
      "charger",
      "charging",
      "battery",
      "case",
      "remote",
      "cable",
      "adapter",
      "tripod",
      "lens",
      "fisheye",
      "dock",
      "carregador",
      "bateria",
      "cabo",
      "adaptador",
      "controle remoto",
    ];

    const cameraSignals = [
      "camera",
      "camcorder",
      "filmadora",
      "handycam",
      "record",
      "recording",
      "playback",
      "tested working",
      "works",
      "nightshot",
      "hdd",
      "minidv",
      "video8",
      "hi8",
    ];

    const softHits = softAccessoryTerms.filter(
      (term) => title.includes(term),
    );
    const hasCameraSignal = cameraSignals.some(
      (term) => title.includes(term),
    );

    if (softHits.length && !hasCameraSignal) {
      return {
        rejected: false,
        penalty: Math.min(
          35,
          18 + softHits.length * 6,
        ),
        reasons: [
          `possível acessório: ${softHits.join(", ")}`,
        ],
      };
    }
  }

  return {
    rejected: false,
    penalty: 0,
    reasons: [],
  };
}

function evaluateRadarCriteria(radar = {}, listing = {}) {
  const config = radarCriteriaConfig(radar);
  const automaticGuard = automaticCategoryGuard(
    radar,
    listing,
  );
  const text = [
    listing.title,
    listing.platform,
    listing.notes,
    listing.condition,
  ]
    .filter(Boolean)
    .join(" ");

  const normalizedHaystack = normalizeText(text);
  const tokenSet = new Set(tokenize(text));
  const query = queryMetrics(
    radar.query,
    normalizedHaystack,
    tokenSet,
  );

  const matchedPriority = config.priorityTerms.filter(
    (term) =>
      termMatches(normalizedHaystack, tokenSet, term),
  );
  const matchedPenalized = config.penalizedTerms.filter(
    (term) =>
      termMatches(normalizedHaystack, tokenSet, term),
  );
  const matchedRequired = config.requiredTerms.filter(
    (term) =>
      termMatches(normalizedHaystack, tokenSet, term),
  );
  const matchedExclude = config.excludeTerms.filter(
    (term) =>
      termMatches(normalizedHaystack, tokenSet, term),
  );

  const hasRequired = config.requiredTerms.length > 0;
  const requiredSatisfied =
    !hasRequired || matchedRequired.length > 0;
  const hasCustomRules =
    config.priorityTerms.length > 0 ||
    config.penalizedTerms.length > 0 ||
    config.requiredTerms.length > 0 ||
    config.excludeTerms.length > 0 ||
    automaticGuard.penalty > 0 ||
    automaticGuard.rejected;

  const reasons = [
    ...automaticGuard.reasons,
  ];
  let score = Math.round(query.fit * 45);

  if (automaticGuard.penalty > 0) {
    score -= automaticGuard.penalty;
  }

  if (query.hits > 0) {
    reasons.push(
      `busca ${Math.round(query.fit * 100)}% compatível`,
    );
  }

  if (matchedPriority.length) {
    score += Math.min(
      35,
      matchedPriority.length * 12,
    );
    reasons.push(
      `prioridade: ${matchedPriority.join(", ")}`,
    );
  }

  if (matchedPenalized.length) {
    score -= Math.min(
      30,
      matchedPenalized.length * 10,
    );
    reasons.push(
      `despriorizar: ${matchedPenalized.join(", ")}`,
    );
  }

  if (hasRequired) {
    if (requiredSatisfied) {
      score += 15;
      reasons.push(
        `obrigatório: ${matchedRequired.join(", ")}`,
      );
    } else {
      reasons.push(
        "não contém nenhum termo obrigatório",
      );
    }
  }

  if (matchedExclude.length) {
    reasons.push(
      `exclusão: ${matchedExclude.join(", ")}`,
    );
  }

  const rawPrice =
    listing.current_price ??
    listing.price;
  const price =
    rawPrice === null || rawPrice === undefined
      ? null
      : Number(rawPrice);
  const maxPrice =
    radar.max_price === null ||
    radar.max_price === undefined ||
    radar.max_price === ""
      ? null
      : Number(radar.max_price);
  const currency = String(
    listing.currency || "BRL",
  ).toUpperCase();
  const itemCountry = String(
    listing.item_country || "",
  ).toUpperCase();
  const foreignMarketplaceItem = itemCountry
    ? itemCountry !== "BR"
    : listing.source_key === "ebay";

  const priceComparable =
    !foreignMarketplaceItem &&
    Number.isFinite(price) &&
    Number.isFinite(maxPrice) &&
    currency === config.budgetCurrency;

  if (priceComparable) {
    if (price <= maxPrice) {
      score += 5;
      reasons.push("preço dentro do teto");
    } else {
      score -= 8;
      reasons.push("preço acima do teto");
    }
  }

  const rejected =
    automaticGuard.rejected ||
    matchedExclude.length > 0 ||
    !requiredSatisfied;

  if (rejected) score = 0;

  score = Math.max(
    0,
    Math.min(100, Math.round(score)),
  );

  let tier = "triagem";
  if (rejected) tier = "descartar";
  else if (score >= 75) tier = "alta";
  else if (score >= 50) tier = "media";
  else tier = "triagem";

  const strongHits =
    query.strongHits +
    matchedPriority.length +
    matchedRequired.length;

  return {
    score,
    tier,
    rejected,
    reasons,
    hasCustomRules,
    requiredSatisfied,
    matchedPriority,
    matchedPenalized,
    matchedRequired,
    matchedExclude,
    queryFit: query.fit,
    queryVariant: query.variant,
    hits: query.hits,
    strongHits,
    weightedHits:
      query.weightedHits +
      matchedPriority.length * 2.5 +
      matchedRequired.length * 3,
    priceComparable,
    budgetCurrency: config.budgetCurrency,
  };
}

function blendCriteriaScore(
  baseScore,
  criteria,
  radar = {},
) {
  const base = Math.max(
    0,
    Math.min(100, Number(baseScore) || 0),
  );

  if (!criteria || criteria.rejected) {
    return criteria?.rejected ? 0 : base;
  }

  if (!criteria.hasCustomRules) {
    return Math.round(base);
  }

  const weight = Math.max(
    0,
    Math.min(
      100,
      Number(radar.criteria_weight ?? 65) || 65,
    ),
  ) / 100;

  return Math.round(
    base * (1 - weight) +
      Number(criteria.score || 0) * weight,
  );
}

module.exports = {
  normalizeText,
  tokenize,
  parseTerms,
  termsJson,
  radarCriteriaConfig,
  automaticCategoryGuard,
  evaluateRadarCriteria,
  blendCriteriaScore,
};
