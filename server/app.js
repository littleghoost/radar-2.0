const express = require("express");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const db = require("./database");
const { registerMobileRelay } = require("./mobileRelay");
const {
  getEbayStatus,
  validateEbayCredentials,
  getOlxStatus,
  getDepopStatus,
} = require("./services/sources");
const { createRadarRunner } = require("./services/radarRunner");
const { createMobileDesktopSync } = require("./services/mobileDesktopSync");
const {
  createSearchPlanner,
} = require("./services/searchPlanner");
const { extractVisualFeatures, downloadImage, visualSimilarity, hybridScore } = require("./services/visualSimilarity");
const { embedImage, cosineSimilarity: semanticSimilarity, status: semanticStatus, MODEL_ID } = require("./services/semanticVision");
const { buildPreferenceProfile, preferenceScore, grailScore } = require("./services/preferenceLearning");
const {
  parseTerms,
  termsJson,
  evaluateRadarCriteria,
  blendCriteriaScore,
} = require("./services/radarCriteria");
const {
  getFxRates,
  estimateBrazilImportCost,
} = require("./services/internationalCost");

const app = express();

const PORT = process.env.PORT || 3000;
const IMAGE_DIR = process.env.IMAGE_DIR || path.join(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, "..", "data"), "reference-images");
fs.mkdirSync(IMAGE_DIR, { recursive: true });

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false }));

registerMobileRelay(app, db);

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1
          ? [part, ""]
          : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function safeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createSessionToken() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET não configurado.");
  return crypto.createHmac("sha256", secret).update("radar-auth-v1").digest("hex");
}

function authEnabled() {
  return Boolean(process.env.RADAR_PASSWORD && process.env.SESSION_SECRET);
}

function isAuthenticated(req) {
  try {
    const token = parseCookies(req).radar_session;
    return Boolean(token && safeEqualText(token, createSessionToken()));
  } catch {
    return false;
  }
}

app.get("/login", (req, res) => {
  if (!authEnabled()) return res.redirect("/");
  if (isAuthenticated(req)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

app.post("/login", (req, res) => {
  const expected = process.env.RADAR_PASSWORD;
  const supplied = req.body.password || "";

  if (!expected || !safeEqualText(supplied, expected)) {
    return res.redirect("/login?error=1");
  }

  const token = createSessionToken();
  res.setHeader(
    "Set-Cookie",
    `radar_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
  );
  res.redirect("/");
});

app.post("/logout", (_req, res) => {
  res.setHeader(
    "Set-Cookie",
    "radar_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
  );
  res.redirect("/login");
});

app.use((req, res, next) => {
  if (!authEnabled()) return next();
  if (req.path === "/api/health") return next();
  if (req.path === "/auth/mercadolivre/callback") return next();
  if (req.path === "/webhooks/ebay/marketplace-account-deletion") return next();
  if (req.path.startsWith("/bridge/")) return next();
  if (req.path === "/mobile" || req.path.startsWith("/mobile/")) return next();
  if (isAuthenticated(req)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Faça login para acessar o Radar." });
  }

  return res.redirect("/login");
});

const EBAY_DELETION_ENDPOINT =
  process.env.EBAY_DELETION_ENDPOINT ||
  "https://radar-2-0-littleghoost.fly.dev/webhooks/ebay/marketplace-account-deletion";

async function getEbayDeletionVerificationToken() {
  if (process.env.EBAY_DELETION_VERIFICATION_TOKEN) {
    return process.env.EBAY_DELETION_VERIFICATION_TOKEN.trim();
  }

  const row = await get(
    `SELECT value
     FROM integration_settings
     WHERE key = 'ebay_deletion_verification_token'
     LIMIT 1`,
  );

  if (row?.value) {
    return String(row.value).trim();
  }

  const stateSecret = process.env.OAUTH_STATE_SECRET;

  if (!stateSecret) {
    return null;
  }

  return crypto
    .createHmac("sha256", stateSecret)
    .update("radar2-ebay-marketplace-account-deletion-v1")
    .digest("base64url");
}

app.get(
  "/webhooks/ebay/marketplace-account-deletion",
  async (req, res) => {
    try {
      const challengeCode = String(
        req.query.challenge_code || "",
      ).trim();

      if (!challengeCode) {
        return res.status(400).json({
          error: "challenge_code ausente.",
        });
      }

      const verificationToken =
        await getEbayDeletionVerificationToken();

      if (!verificationToken) {
        return res.status(503).json({
          error: "Verification token do eBay não configurado.",
        });
      }

      const challengeResponse = crypto
        .createHash("sha256")
        .update(
          challengeCode +
            verificationToken +
            EBAY_DELETION_ENDPOINT,
        )
        .digest("hex");

      res
        .status(200)
        .type("application/json")
        .json({ challengeResponse });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.post(
  "/webhooks/ebay/marketplace-account-deletion",
  async (_req, res) => {
    // O Radar não persiste o payload de exclusão nem identificadores do usuário.
    // Acknowledge imediato para impedir retries desnecessários do eBay.
    res.status(204).end();
  },
);

app.get("/api/image-proxy", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "");
    const parsed = new URL(rawUrl);

    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "img.olx.com.br"
    ) {
      return res.status(400).json({ error: "Imagem não permitida." });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(parsed.href, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Referer: "https://www.olx.com.br/",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(response.status).end();
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.startsWith("image/")) {
      return res.status(415).end();
    }

    const declaredLength = Number(
      response.headers.get("content-length") || 0,
    );

    if (declaredLength > 12 * 1024 * 1024) {
      return res.status(413).end();
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > 12 * 1024 * 1024) {
      return res.status(413).end();
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(buffer);
  } catch {
    return res.status(502).end();
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));

/* =========================
   FUNÇÕES DO BANCO
========================= */

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(
      sql,
      params,

      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      },
    );
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(
      sql,
      params,

      (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      },
    );
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(
      sql,
      params,

      function (err) {
        if (err) {
          reject(err);
        } else {
          resolve({
            id: this.lastID,
            changes: this.changes,
          });
        }
      },
    );
  });
}


async function getPreferenceProfile(category = "geral") {
  const rows = await all(
    `SELECT l.status, l.image_embedding_json
     FROM listings l
     LEFT JOIN radars r ON r.id = l.radar_id
     WHERE COALESCE(r.category, 'geral') = ?
       AND l.status IN ('interessante', 'descartado')
       AND l.image_embedding_json IS NOT NULL`,
    [category || "geral"],
  );
  return buildPreferenceProfile(rows, category || "geral");
}

async function rebuildPreferenceScores(category = null) {
  const params = [];
  let filter = "";
  if (category) {
    filter = "WHERE COALESCE(r.category, 'geral') = ?";
    params.push(category);
  }
  const listings = await all(
    `SELECT l.id, l.hybrid_score, l.image_embedding_json, COALESCE(r.category, 'geral') AS category
     FROM listings l
     LEFT JOIN radars r ON r.id = l.radar_id
     ${filter}`,
    params,
  );
  const categories = [...new Set(listings.map((row) => row.category || "geral"))];
  const profiles = new Map();
  for (const key of categories) profiles.set(key, await getPreferenceProfile(key));

  let updated = 0;
  for (const listing of listings) {
    let embedding = null;
    try {
      embedding = listing.image_embedding_json ? JSON.parse(listing.image_embedding_json) : null;
    } catch {}
    const profile = profiles.get(listing.category || "geral");
    const learned = preferenceScore(embedding, profile);
    const grail = grailScore(listing.hybrid_score, learned, profile?.total_feedback || 0);
    await run("UPDATE listings SET preference_score = ?, grail_score = ? WHERE id = ?", [learned, grail, listing.id]);
    updated += 1;
  }
  return { updated, profiles: [...profiles.values()].map(({ positive_centroid, negative_centroid, ...rest }) => rest) };
}

const DEFAULT_INTERNATIONAL_COST_SETTINGS = {
  enabled: true,
  program: "outside_prc",
  icms_rate_percent: 20,
  handling_fee_brl: 0,
  destination_country: "BR",
  destination_postal_code: "",
};

function normalizeInternationalCostSettings(value = {}) {
  const settings = {
    ...DEFAULT_INTERNATIONAL_COST_SETTINGS,
    ...(value || {}),
  };

  settings.enabled = Boolean(settings.enabled);
  settings.program =
    settings.program === "prc"
      ? "prc"
      : "outside_prc";
  settings.icms_rate_percent = Math.max(
    0,
    Math.min(
      30,
      Number(settings.icms_rate_percent ?? 20) || 20,
    ),
  );
  settings.handling_fee_brl = Math.max(
    0,
    Number(settings.handling_fee_brl) || 0,
  );
  // A estimativa tributária desta versão é específica para importações ao Brasil.
  settings.destination_country = "BR";
  settings.destination_postal_code = String(
    settings.destination_postal_code || "",
  )
    .replace(/[^0-9A-Za-z-]/g, "")
    .slice(0, 16);

  return settings;
}

function shouldEstimateInternationalCost(listing = {}) {
  const currency = String(
    listing.currency || "BRL",
  ).toUpperCase();
  const itemCountry = String(
    listing.item_country || "",
  ).toUpperCase();

  if (itemCountry === "BR") {
    return false;
  }

  if (itemCountry && itemCountry !== "BR") {
    return true;
  }

  return currency !== "BRL";
}

async function getInternationalCostSettings() {
  const row = await get(
    `SELECT value
     FROM integration_settings
     WHERE key = 'international_cost_profile'
     LIMIT 1`,
  );

  if (!row?.value) {
    return {
      ...DEFAULT_INTERNATIONAL_COST_SETTINGS,
    };
  }

  try {
    return normalizeInternationalCostSettings(
      JSON.parse(row.value),
    );
  } catch {
    return {
      ...DEFAULT_INTERNATIONAL_COST_SETTINGS,
    };
  }
}

async function saveInternationalCostSettings(input = {}) {
  const current =
    await getInternationalCostSettings();
  const patch = Object.fromEntries(
    Object.entries(input).filter(
      ([, value]) => value !== undefined,
    ),
  );
  const next = normalizeInternationalCostSettings({
    ...current,
    ...patch,
  });

  await run(
    `INSERT INTO integration_settings
      (key, value, updated_at)
     VALUES ('international_cost_profile', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = CURRENT_TIMESTAMP`,
    [JSON.stringify(next)],
  );

  return next;
}

const searchPlanner = createSearchPlanner({
  get,
  all,
  run,
});

const radarRunner = createRadarRunner({
  get,
  all,
  run,
  getValidMercadoLivreConnection,
  getInternationalCostSettings,
});

const mobileDesktopSync = createMobileDesktopSync({
  db,
  radarRunner,
});

async function scoreListingForRadar({
  radarId,
  title,
  imageUrl,
  currentPrice,
  currency = "BRL",
  sourceKey = null,
  itemCountry = null,
}) {
  if (!radarId) {
    return { visual_score: null, semantic_score: null, hybrid_score: null, preference_score: null, grail_score: null, image_features_json: null, image_embedding_json: null };
  }

  const radar = await get("SELECT * FROM radars WHERE id = ?", [radarId]);
  if (!radar) {
    return { visual_score: null, semantic_score: null, hybrid_score: null, preference_score: null, grail_score: null, image_features_json: null, image_embedding_json: null };
  }

  let visual = null;
  let semantic = null;
  let features = null;
  let embedding = null;
  let imageBuffer = null;

  if (imageUrl && (radar.visual_enabled || radar.semantic_enabled)) {
    try {
      imageBuffer = await downloadImage(imageUrl);
    } catch {
      imageBuffer = null;
    }
  }

  if (radar.visual_enabled && radar.reference_features_json) {
    if (imageBuffer) {
      try {
        features = await extractVisualFeatures(imageBuffer);
        visual = visualSimilarity(JSON.parse(radar.reference_features_json), features);
      } catch {
        visual = 0;
      }
    } else {
      visual = 0;
    }
  }

  if (radar.semantic_enabled && radar.reference_embedding_json) {
    if (imageBuffer) {
      try {
        embedding = await embedImage(imageBuffer);
        semantic = semanticSimilarity(JSON.parse(radar.reference_embedding_json), embedding);
      } catch {
        semantic = 0;
      }
    } else {
      semantic = 0;
    }
  }

  const normalizedCountry = String(
    itemCountry || "",
  ).toUpperCase();
  const foreignMarketplaceItem = normalizedCountry
    ? normalizedCountry !== "BR"
    : sourceKey === "ebay";

  const hybrid = hybridScore({
    visual: radar.visual_enabled && radar.reference_features_json ? visual : null,
    semantic: radar.semantic_enabled && radar.reference_embedding_json ? semantic : null,
    query: radar.query,
    title,
    price: currentPrice === "" ? null : currentPrice,
    maxPrice: foreignMarketplaceItem
      ? null
      : radar.max_price,
    currency,
    visualWeight: radar.visual_weight || 70,
    semanticWeight: radar.semantic_weight || 70,
  });

  const profile = await getPreferenceProfile(radar.category || "geral");
  const learned = preferenceScore(embedding, profile);
  const grail = grailScore(hybrid, learned, profile.total_feedback);

  return {
    visual_score: visual === null ? null : Math.round(visual * 100),
    semantic_score: semantic === null ? null : Math.round(semantic * 100),
    hybrid_score: hybrid,
    preference_score: learned,
    grail_score: grail,
    image_features_json: features ? JSON.stringify(features) : null,
    image_embedding_json: embedding ? JSON.stringify(embedding) : null,
  };
}

const AUTO_ASSIGN_STOPWORDS = new Set([
  "para", "com", "sem", "por", "uma", "uns", "das", "dos", "de", "da", "do",
  "the", "and", "for", "completa", "original", "vintage", "camera", "filmadora",
]);

function normalizeSearchWords(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !AUTO_ASSIGN_STOPWORDS.has(word));
}

function radarMatchMetrics(radar, listing) {
  const criteria = evaluateRadarCriteria(radar, listing);

  return {
    fit: criteria.queryFit,
    hits: criteria.hits,
    strongHits: criteria.strongHits,
    weightedHits: criteria.weightedHits,
    criteria,
  };
}

function radarTextFit(radar, listing) {
  return radarMatchMetrics(radar, listing).fit;
}

async function reapplyCriteriaForRadar(radar) {
  const listings = await all(
    "SELECT * FROM listings WHERE radar_id = ?",
    [radar.id],
  );

  const summary = {
    total: listings.length,
    alta: 0,
    media: 0,
    triagem: 0,
    rejected: 0,
  };

  for (const listing of listings) {
    const criteria = evaluateRadarCriteria(
      radar,
      listing,
    );

    if (criteria.rejected) {
      summary.rejected += 1;
    } else if (criteria.tier === "alta") {
      summary.alta += 1;
    } else if (criteria.tier === "media") {
      summary.media += 1;
    } else {
      summary.triagem += 1;
    }

    await run(
      `UPDATE listings
       SET rule_score = ?,
           rule_tier = ?,
           rule_rejected = ?,
           rule_reason_json = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        criteria.score,
        criteria.tier,
        criteria.rejected ? 1 : 0,
        JSON.stringify(criteria.reasons),
        listing.id,
      ],
    );
  }

  return summary;
}

async function applyRadarToListing(listing, radarId) {
  const intelligence = await scoreListingForRadar({
    radarId,
    title: listing.title,
    imageUrl: listing.image_url,
    currentPrice: listing.current_price,
    currency: listing.currency || "BRL",
    sourceKey: listing.source_key || null,
    itemCountry: listing.item_country || null,
  });

  const radar = radarId
    ? await get("SELECT * FROM radars WHERE id = ?", [radarId])
    : null;
  const criteria = radar
    ? evaluateRadarCriteria(radar, listing)
    : null;

  await run(
    `UPDATE listings
     SET radar_id = ?, visual_score = ?, semantic_score = ?, hybrid_score = ?,
         image_features_json = ?, image_embedding_json = ?,
         preference_score = ?, grail_score = ?,
         rule_score = ?, rule_tier = ?, rule_rejected = ?,
         rule_reason_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      radarId || null,
      intelligence.visual_score,
      intelligence.semantic_score,
      intelligence.hybrid_score,
      intelligence.image_features_json,
      intelligence.image_embedding_json,
      intelligence.preference_score,
      intelligence.grail_score,
      criteria?.score ?? null,
      criteria?.tier ?? null,
      criteria?.rejected ? 1 : 0,
      JSON.stringify(criteria?.reasons || []),
      listing.id,
    ],
  );

  return {
    ...intelligence,
    criteria,
  };
}

function deriveListingInsights(listing) {
  const rawTitle = String(listing.title || "");
  const title = rawTitle
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const tags = [];
  const reasons = [];

  const addTag = (tag) => {
    if (tag && !tags.includes(tag)) tags.push(tag);
  };

  if (/nightshot|visao noturna|visao nocturna/.test(title)) {
    addTag("NightShot");
  }

  if (/\bhdd\b|hard\s*disk|disco\s*rigido/.test(title)) {
    addTag("HDD");
  }

  const srModel = rawTitle.match(/\b(?:DCR[\s-]*)?(SR\d+)\b/i);
  if (srModel) {
    addTag(srModel[1].toUpperCase());
  }

  const dcrModel = rawTitle.match(/\bDCR[\s-]*([A-Z]{1,5}\d+[A-Z0-9]*)\b/i);
  if (dcrModel && !srModel) {
    addTag(`DCR-${dcrModel[1].toUpperCase()}`);
  }

  if (/\bmini\s*dv\b/.test(title)) addTag("MiniDV");
  if (/\bhi8\b/.test(title)) addTag("Hi8");
  if (/\bvideo\s*8\b|\bvideo8\b/.test(title)) addTag("Video8");
  if (/\bdigital\s*8\b|\bdigital8\b/.test(title)) addTag("Digital8");
  if (/\bdvd\b/.test(title)) addTag("DVD");
  if (/\b4k\b/.test(title)) addTag("4K");
  if (/projetor/.test(title)) addTag("Projetor");
  if (/\blote\b/.test(title)) addTag("Lote");
  if (/rara|raro|vintage|retro|colecionador/.test(title)) addTag("Vintage/Rara");
  if (/nova|novo|nunca usada|nunca usado/.test(title)) addTag("Nova");
  if (/completa|completo|acessorios|acessorio/.test(title)) addTag("Completa");
  if (/nao funciona|nao sei se funciona|defeito|retirada de pecas|para pecas|reparo|sucata/.test(title)) {
    addTag("Reparo");
  }

  if (listing.availability_status === "unavailable") {
    addTag("Indisponível");
    reasons.push(
      listing.availability_detail
        ? `fonte marcou como ${listing.availability_detail}`
        : "fonte marcou como indisponível",
    );
  } else if (listing.availability_status === "available") {
    addTag("Disponível");
  }

  const currentPrice =
    listing.current_price === null || listing.current_price === undefined
      ? null
      : Number(listing.current_price);

  const maxPrice =
    listing.radar_max_price === null || listing.radar_max_price === undefined
      ? null
      : Number(listing.radar_max_price);

  const budgetCurrency = String(
    listing.radar_budget_currency || "BRL",
  ).toUpperCase();
  const listingCurrency = String(
    listing.currency || "BRL",
  ).toUpperCase();
  const itemCountry = String(
    listing.item_country || "",
  ).toUpperCase();
  const foreignMarketplaceItem = itemCountry
    ? itemCountry !== "BR"
    : listing.source_key === "ebay";

  if (foreignMarketplaceItem) {
    addTag("Importação");
    reasons.push(
      "custo internacional calculado separadamente",
    );
  } else if (
    Number.isFinite(currentPrice) &&
    Number.isFinite(maxPrice) &&
    listingCurrency === budgetCurrency
  ) {
    if (currentPrice <= maxPrice) {
      addTag("Dentro do teto");
      reasons.push("preço dentro do teto do radar");
    } else {
      addTag("Acima do teto");
      reasons.push("preço acima do teto do radar");
    }
  } else if (
    Number.isFinite(currentPrice) &&
    Number.isFinite(maxPrice) &&
    listingCurrency !== budgetCurrency
  ) {
    addTag("Moeda externa");
    reasons.push(
      `teto em ${budgetCurrency} não aplicado a ${listingCurrency}`,
    );
  }

  const firstPrice =
    listing.first_price === null || listing.first_price === undefined
      ? null
      : Number(listing.first_price);

  if (
    Number.isFinite(firstPrice) &&
    Number.isFinite(currentPrice) &&
    currentPrice < firstPrice
  ) {
    const dropPercent = Math.round(((firstPrice - currentPrice) / firstPrice) * 100);
    addTag("Preço caiu");
    reasons.push(`preço caiu ${dropPercent}%`);
  }

  let matchMetrics = null;

  if (listing.radar_query) {
    matchMetrics = radarMatchMetrics(
      {
        query: listing.radar_query,
        max_price: listing.radar_max_price,
        priority_terms_json:
          listing.radar_priority_terms_json,
        penalized_terms_json:
          listing.radar_penalized_terms_json,
        required_terms_json:
          listing.radar_required_terms_json,
        exclude_terms_json:
          listing.radar_exclude_terms_json,
        criteria_weight:
          listing.radar_criteria_weight,
        budget_currency:
          listing.radar_budget_currency,
      },
      listing,
    );

    const criteria = matchMetrics.criteria;

    if (criteria?.tier === "alta") {
      addTag("Prioridade alta");
    } else if (criteria?.tier === "media") {
      addTag("Prioridade média");
    }

    if (criteria?.rejected) {
      addTag("Fora dos critérios");
    }

    for (const reason of criteria?.reasons || []) {
      if (!reasons.includes(reason)) {
        reasons.push(reason);
      }
    }
  }

  const baseScore = Number(
    listing.grail_score ?? listing.hybrid_score ?? 0,
  );

  const ruleCriteria = matchMetrics?.criteria || null;

  let inboxScore = Number.isFinite(baseScore) ? baseScore : 0;

  if (ruleCriteria?.hasCustomRules) {
    inboxScore = blendCriteriaScore(
      inboxScore,
      ruleCriteria,
      {
        criteria_weight:
          listing.radar_criteria_weight,
      },
    );
  } else if (matchMetrics?.strongHits) {
    inboxScore += Math.min(
      24,
      matchMetrics.strongHits * 12,
    );
  }

  if (tags.includes("Dentro do teto")) inboxScore += 10;
  if (tags.includes("Acima do teto")) inboxScore -= 10;
  if (tags.includes("Preço caiu")) inboxScore += 8;
  if (listing.availability_status === "unavailable") inboxScore -= 50;
  if (listing.status === "interessante") inboxScore += 15;
  if (listing.status === "descartado" || listing.status === "vendido") inboxScore -= 30;

  if (ruleCriteria?.rejected) {
    inboxScore = 0;
  }

  inboxScore = Math.max(
    0,
    Math.min(100, Math.round(inboxScore)),
  );

  let inboxTier = "triagem";

  if (listing.radar_id) {
    if (ruleCriteria?.rejected) inboxTier = "ruido";
    else if (inboxScore >= 80) inboxTier = "grail";
    else if (inboxScore >= 55) inboxTier = "provavel";
    else if (inboxScore >= 25) inboxTier = "talvez";
    else inboxTier = "ruido";
  }

  if (listing.radar_name) {
    reasons.unshift(`radar: ${listing.radar_name}`);
  } else {
    reasons.push("ainda sem radar definido");
  }

  if (Number.isFinite(baseScore) && baseScore > 0) {
    reasons.push(`score base ${Math.round(baseScore)}/100`);
  }

  if (tags.includes("NightShot")) reasons.push("NightShot detectado no título");
  if (srModel) reasons.push(`modelo ${srModel[1].toUpperCase()} detectado`);

  return {
    tags: tags.slice(0, 8),
    inbox_score: inboxScore,
    inbox_tier: inboxTier,
    rule_score:
      ruleCriteria?.score ??
      listing.rule_score ??
      null,
    rule_tier:
      ruleCriteria?.tier ??
      listing.rule_tier ??
      null,
    rule_rejected: Boolean(
      ruleCriteria?.rejected ??
      listing.rule_rejected,
    ),
    rule_reasons:
      ruleCriteria?.reasons || [],
    score_reason: reasons.slice(0, 5).join(" • "),
  };
}

async function autoAssignListing(listing, radars) {
  const candidates = radars
    .map((radar) => ({
      radar,
      metrics: radarMatchMetrics(radar, listing),
    }))
    .filter((candidate) => {
      const criteria = candidate.metrics.criteria;

      if (criteria?.rejected) return false;

      if (criteria?.hasCustomRules) {
        return (
          criteria.score >= 25 ||
          criteria.matchedPriority.length > 0 ||
          criteria.matchedRequired.length > 0
        );
      }

      return (
        candidate.metrics.strongHits > 0 ||
        candidate.metrics.weightedHits >= 2.5
      );
    })
    .sort((a, b) => {
      const scoreA = a.metrics.criteria?.score || 0;
      const scoreB = b.metrics.criteria?.score || 0;

      if (scoreB !== scoreA) return scoreB - scoreA;
      return b.metrics.fit - a.metrics.fit;
    })
    .slice(0, 3);

  if (!candidates.length) return null;

  let best = null;

  for (const candidate of candidates) {
    const intelligence = await scoreListingForRadar({
      radarId: candidate.radar.id,
      title: listing.title,
      imageUrl: listing.image_url,
      currentPrice: listing.current_price,
      currency: listing.currency || "BRL",
      sourceKey: listing.source_key || null,
      itemCountry: listing.item_country || null,
    });

    const intelligenceScore = Number(
      intelligence.grail_score ?? intelligence.hybrid_score ?? 0,
    );

    const criteria = candidate.metrics.criteria;
    const criteriaScore = blendCriteriaScore(
      intelligenceScore,
      criteria,
      candidate.radar,
    );
    const combined = Math.min(
      100,
      criteriaScore + candidate.metrics.fit * 15,
    );

    if (!best || combined > best.combined) {
      best = {
        radar: candidate.radar,
        intelligence,
        metrics: candidate.metrics,
        combined,
      };
    }
  }

  if (!best) {
    return null;
  }

  await run(
    `UPDATE listings
     SET radar_id = ?, visual_score = ?, semantic_score = ?, hybrid_score = ?,
         image_features_json = ?, image_embedding_json = ?,
         preference_score = ?, grail_score = ?,
         rule_score = ?, rule_tier = ?, rule_rejected = ?,
         rule_reason_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      best.radar.id,
      best.intelligence.visual_score,
      best.intelligence.semantic_score,
      best.intelligence.hybrid_score,
      best.intelligence.image_features_json,
      best.intelligence.image_embedding_json,
      best.intelligence.preference_score,
      best.intelligence.grail_score,
      best.metrics.criteria?.score ?? null,
      best.metrics.criteria?.tier ?? null,
      best.metrics.criteria?.rejected ? 1 : 0,
      JSON.stringify(best.metrics.criteria?.reasons || []),
      listing.id,
    ],
  );

  return {
    radar_id: best.radar.id,
    radar_name: best.radar.name,
    score: Math.round(best.combined),
  };
}

async function createBridgeSmartAlertForNewListing(
  listing,
) {
  if (!listing?.radar_id) return false;

  const radar = await get(
    "SELECT * FROM radars WHERE id = ?",
    [listing.radar_id],
  );

  if (!radar || !Boolean(radar.smart_alerts_enabled ?? 1)) {
    return false;
  }

  const criteria = evaluateRadarCriteria(
    radar,
    listing,
  );

  if (criteria.rejected) return false;

  const baseScore = Number(
    listing.grail_score ??
      listing.hybrid_score ??
      listing.rule_score ??
      0,
  );

  const rankingScore = blendCriteriaScore(
    baseScore,
    criteria,
    radar,
  );

  const minScore = Math.max(
    0,
    Math.min(
      100,
      Number(radar.alert_min_score ?? 78) || 78,
    ),
  );

  if (rankingScore < minScore) {
    return false;
  }

  await run(
    `INSERT INTO activity_events
      (radar_id, listing_id, type, title, detail, metadata_json)
     VALUES (?, ?, 'smart_alert', ?, ?, ?)`,
    [
      radar.id,
      listing.id,
      `Achado forte: ${listing.title}`,
      `${listing.platform} • score ${Math.round(rankingScore)}/100`,
      JSON.stringify({
        kind: "high_score_new_listing",
        score: rankingScore,
        threshold: minScore,
        url: listing.url || null,
        platform: listing.platform || null,
        captured_by_bridge: true,
      }),
    ],
  );

  return true;
}

async function createBridgeSmartPriceDropAlert({
  listing,
  previousPrice,
  nextPrice,
  currency,
}) {
  if (
    !listing?.radar_id ||
    !Number.isFinite(previousPrice) ||
    previousPrice <= 0 ||
    !Number.isFinite(nextPrice)
  ) {
    return false;
  }

  const radar = await get(
    "SELECT * FROM radars WHERE id = ?",
    [listing.radar_id],
  );

  if (!radar || !Boolean(radar.smart_alerts_enabled ?? 1)) {
    return false;
  }

  const dropPercent =
    ((previousPrice - nextPrice) / previousPrice) *
    100;
  const threshold = Math.max(
    0,
    Math.min(
      100,
      Number(radar.alert_price_drop_percent ?? 10) || 10,
    ),
  );

  if (dropPercent < threshold) {
    return false;
  }

  await run(
    `INSERT INTO activity_events
      (radar_id, listing_id, type, title, detail, metadata_json)
     VALUES (?, ?, 'smart_alert', ?, ?, ?)`,
    [
      radar.id,
      listing.id,
      `Queda relevante: ${listing.title}`,
      `${currency} ${previousPrice} → ${currency} ${nextPrice} (-${dropPercent.toFixed(1)}%)`,
      JSON.stringify({
        kind: "significant_price_drop",
        drop_percent: dropPercent,
        threshold,
        previous_price: previousPrice,
        current_price: nextPrice,
        currency,
        url: listing.url || null,
        platform: listing.platform || null,
        captured_by_bridge: true,
      }),
    ],
  );

  return true;
}

/* =========================
   HEALTH
========================= */

app.get("/api/health", async (_req, res) => {
  try {
    await get("SELECT 1 AS ok");
    res.json({
      ok: true,
      service: "radar-2.0",
      database: "ok",
      semantic: semanticStatus(),
      uptime_seconds: Math.round(process.uptime()),
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      service: "radar-2.0",
      database: "error",
    });
  }
});

/* =========================
   RADARES
========================= */

app.get(
  "/api/radars",

  async (_req, res) => {
    try {
      const rows = await all(`

        SELECT
          r.*,

          COUNT(l.id)
            AS listing_count,

          SUM(
            CASE
              WHEN l.status = 'interessante'
              THEN 1
              ELSE 0
            END
          )
            AS interesting_count,

          (SELECT rr.started_at FROM radar_runs rr WHERE rr.radar_id = r.id ORDER BY rr.id DESC LIMIT 1) AS last_run_at,
          (SELECT rr.status FROM radar_runs rr WHERE rr.radar_id = r.id ORDER BY rr.id DESC LIMIT 1) AS last_run_status

        FROM radars r

        LEFT JOIN listings l
          ON l.radar_id = r.id

        GROUP BY r.id

        ORDER BY r.created_at DESC

      `);

      res.json(rows);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   CRIAR RADAR
========================= */

app.post(
  "/api/radars",

  async (req, res) => {
    try {
      const {
        name,
        query,
        max_price,
        category,
        visual_enabled,
        visual_weight,
        min_visual_similarity,
        semantic_enabled,
        semantic_weight,
        priority_terms,
        penalized_terms,
        required_terms,
        exclude_terms,
        criteria_weight,
        budget_currency,
        smart_alerts_enabled,
        alert_min_score,
        alert_price_drop_percent,
      } = req.body;

      if (!name || !query) {
        return res.status(400).json({
          error: "Nome e busca são obrigatórios.",
        });
      }

      const result = await run(
        `
        INSERT INTO radars
        (
          name,
          query,
          max_price,
          category,
          visual_enabled,
          visual_weight,
          min_visual_similarity,
          semantic_enabled,
          semantic_weight,
          priority_terms_json,
          penalized_terms_json,
          required_terms_json,
          exclude_terms_json,
          criteria_weight,
          budget_currency,
          smart_alerts_enabled,
          alert_min_score,
          alert_price_drop_percent
        )

        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,

        [
          name.trim(),
          query.trim(),

          max_price === "" ? null : max_price,

          category || "geral",
          visual_enabled ? 1 : 0,
          Math.min(100, Math.max(0, Number(visual_weight) || 70)),
          Math.min(1, Math.max(0, Number(min_visual_similarity) || 0.45)),
          semantic_enabled === undefined ? 1 : (semantic_enabled ? 1 : 0),
          Math.min(100, Math.max(0, Number(semantic_weight) || 70)),
          termsJson(priority_terms),
          termsJson(penalized_terms),
          termsJson(required_terms),
          termsJson(exclude_terms),
          Math.min(100, Math.max(0, Number(criteria_weight) || 65)),
          ["BRL", "USD", "EUR", "GBP", "JPY"].includes(
            String(budget_currency || "BRL").toUpperCase(),
          )
            ? String(budget_currency || "BRL").toUpperCase()
            : "BRL",
          smart_alerts_enabled === undefined
            ? 1
            : smart_alerts_enabled
              ? 1
              : 0,
          Math.min(
            100,
            Math.max(
              0,
              Number(alert_min_score ?? 78) || 78,
            ),
          ),
          Math.min(
            100,
            Math.max(
              0,
              Number(alert_price_drop_percent ?? 10) || 10,
            ),
          ),
        ],
      );

      const radar = await get(
        "SELECT * FROM radars WHERE id = ?",

        [result.id],
      );

      await searchPlanner.ensurePlan(radar);

      res.status(201).json(radar);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   IMAGEM DE REFERÊNCIA
========================= */

app.put(
  "/api/radars/:id/reference-image",
  express.raw({ type: ["image/*", "application/octet-stream"], limit: "8mb" }),
  async (req, res) => {
    try {
      const radar = await get("SELECT * FROM radars WHERE id = ?", [req.params.id]);
      if (!radar) return res.status(404).json({ error: "Radar não encontrado." });
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: "Envie uma imagem válida." });
      }

      const contentType = req.headers["content-type"] || "image/jpeg";
      const ext = contentType.includes("png") ? ".png" : contentType.includes("webp") ? ".webp" : ".jpg";
      const filePath = path.join(IMAGE_DIR, `radar-${radar.id}${ext}`);
      await fsp.writeFile(filePath, req.body);
      const features = await extractVisualFeatures(req.body);
      let embedding = null;
      let semanticError = null;
      if (radar.semantic_enabled) {
        try {
          embedding = await embedImage(req.body);
        } catch (error) {
          semanticError = error?.message || String(error);
        }
      }

      await run(
        `UPDATE radars
         SET reference_image_path = ?, reference_features_json = ?, visual_enabled = 1,
             reference_embedding_json = ?, semantic_model = ?
         WHERE id = ?`,
        [filePath, JSON.stringify(features), embedding ? JSON.stringify(embedding) : null, embedding ? MODEL_ID : null, radar.id],
      );

      res.json({
        ok: true,
        radar_id: radar.id,
        visual_enabled: true,
        reference_image_url: `/api/radars/${radar.id}/reference-image`,
        features: {
          width: features.width,
          height: features.height,
          average_rgb: features.average_rgb,
        },
        semantic: {
          enabled: Boolean(radar.semantic_enabled),
          ready: Boolean(embedding),
          model: embedding ? MODEL_ID : null,
          error: semanticError,
        },
      });
    } catch (err) {
      res.status(400).json({ error: `Não consegui analisar a imagem: ${err.message}` });
    }
  },
);

app.post("/api/radars/:id/reindex-visual", async (req, res) => {
  try {
    const radar = await get("SELECT * FROM radars WHERE id = ?", [req.params.id]);
    if (!radar) return res.status(404).json({ error: "Radar não encontrado." });

    const listings = await all(
      "SELECT * FROM listings WHERE radar_id = ? ORDER BY updated_at DESC LIMIT 100",
      [radar.id],
    );

    let analyzed = 0;
    let failed = 0;
    for (const listing of listings) {
      try {
        const score = await scoreListingForRadar({
          radarId: radar.id,
          title: listing.title,
          imageUrl: listing.image_url,
          currentPrice: listing.current_price,
          currency: listing.currency || "BRL",
          sourceKey: listing.source_key || null,
          itemCountry: listing.item_country || null,
        });
        await run(
          `UPDATE listings
           SET visual_score = ?, semantic_score = ?, hybrid_score = ?,
               image_features_json = COALESCE(?, image_features_json),
               image_embedding_json = COALESCE(?, image_embedding_json),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [score.visual_score, score.semantic_score, score.hybrid_score, score.image_features_json, score.image_embedding_json, listing.id],
        );
        analyzed += 1;
      } catch {
        failed += 1;
      }
    }

    res.json({ ok: true, analyzed, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/radars/:id/reference-image", async (req, res) => {
  try {
    const radar = await get("SELECT reference_image_path FROM radars WHERE id = ?", [req.params.id]);
    if (!radar?.reference_image_path) return res.status(404).end();
    res.sendFile(path.resolve(radar.reference_image_path));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/radars/:id/reference-image", async (req, res) => {
  try {
    const radar = await get("SELECT reference_image_path FROM radars WHERE id = ?", [req.params.id]);
    if (radar?.reference_image_path) {
      await fsp.unlink(radar.reference_image_path).catch(() => {});
    }
    await run(
      "UPDATE radars SET reference_image_path = NULL, reference_features_json = NULL, reference_embedding_json = NULL, semantic_model = NULL, visual_enabled = 0 WHERE id = ?",
      [req.params.id],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   EDITAR RADAR
========================= */

app.patch(
  "/api/radars/:id",

  async (req, res) => {
    try {
      const radar = await get(
        "SELECT * FROM radars WHERE id = ?",

        [req.params.id],
      );

      if (!radar) {
        return res.status(404).json({
          error: "Radar não encontrado.",
        });
      }

      const next = {
        name: req.body.name !== undefined ? req.body.name : radar.name,

        query: req.body.query !== undefined ? req.body.query : radar.query,

        max_price:
          req.body.max_price !== undefined
            ? req.body.max_price
            : radar.max_price,

        category:
          req.body.category !== undefined ? req.body.category : radar.category,
        visual_enabled:
          req.body.visual_enabled !== undefined ? Boolean(req.body.visual_enabled) : Boolean(radar.visual_enabled),
        visual_weight:
          req.body.visual_weight !== undefined ? Math.min(100, Math.max(0, Number(req.body.visual_weight) || 70)) : Number(radar.visual_weight || 70),
        min_visual_similarity:
          req.body.min_visual_similarity !== undefined ? Math.min(1, Math.max(0, Number(req.body.min_visual_similarity) || 0.45)) : Number(radar.min_visual_similarity || 0.45),
        semantic_enabled:
          req.body.semantic_enabled !== undefined ? Boolean(req.body.semantic_enabled) : Boolean(radar.semantic_enabled),
        semantic_weight:
          req.body.semantic_weight !== undefined ? Math.min(100, Math.max(0, Number(req.body.semantic_weight) || 70)) : Number(radar.semantic_weight || 70),
        priority_terms_json:
          req.body.priority_terms !== undefined
            ? termsJson(req.body.priority_terms)
            : radar.priority_terms_json || "[]",
        penalized_terms_json:
          req.body.penalized_terms !== undefined
            ? termsJson(req.body.penalized_terms)
            : radar.penalized_terms_json || "[]",
        required_terms_json:
          req.body.required_terms !== undefined
            ? termsJson(req.body.required_terms)
            : radar.required_terms_json || "[]",
        exclude_terms_json:
          req.body.exclude_terms !== undefined
            ? termsJson(req.body.exclude_terms)
            : radar.exclude_terms_json || "[]",
        criteria_weight:
          req.body.criteria_weight !== undefined
            ? Math.min(100, Math.max(0, Number(req.body.criteria_weight) || 65))
            : Number(radar.criteria_weight || 65),
        budget_currency:
          req.body.budget_currency !== undefined &&
          ["BRL", "USD", "EUR", "GBP", "JPY"].includes(
            String(req.body.budget_currency).toUpperCase(),
          )
            ? String(req.body.budget_currency).toUpperCase()
            : String(radar.budget_currency || "BRL").toUpperCase(),
        smart_alerts_enabled:
          req.body.smart_alerts_enabled !== undefined
            ? Boolean(req.body.smart_alerts_enabled)
            : Boolean(radar.smart_alerts_enabled),
        alert_min_score:
          req.body.alert_min_score !== undefined
            ? Math.min(
                100,
                Math.max(
                  0,
                  Number(req.body.alert_min_score) || 78,
                ),
              )
            : Number(radar.alert_min_score ?? 78),
        alert_price_drop_percent:
          req.body.alert_price_drop_percent !== undefined
            ? Math.min(
                100,
                Math.max(
                  0,
                  Number(req.body.alert_price_drop_percent) || 10,
                ),
              )
            : Number(radar.alert_price_drop_percent ?? 10),
      };

      if (!next.name || !next.query) {
        return res.status(400).json({
          error: "Nome e busca são obrigatórios.",
        });
      }

      await run(
        `
        UPDATE radars

        SET
          name = ?,
          query = ?,
          max_price = ?,
          category = ?,
          visual_enabled = ?,
          visual_weight = ?,
          min_visual_similarity = ?,
          semantic_enabled = ?,
          semantic_weight = ?,
          priority_terms_json = ?,
          penalized_terms_json = ?,
          required_terms_json = ?,
          exclude_terms_json = ?,
          criteria_weight = ?,
          budget_currency = ?,
          smart_alerts_enabled = ?,
          alert_min_score = ?,
          alert_price_drop_percent = ?

        WHERE id = ?
        `,

        [
          next.name.trim(),
          next.query.trim(),

          next.max_price === "" ? null : next.max_price,

          next.category || "geral",
          next.visual_enabled ? 1 : 0,
          next.visual_weight,
          next.min_visual_similarity,
          next.semantic_enabled ? 1 : 0,
          next.semantic_weight,
          next.priority_terms_json,
          next.penalized_terms_json,
          next.required_terms_json,
          next.exclude_terms_json,
          next.criteria_weight,
          next.budget_currency,
          next.smart_alerts_enabled ? 1 : 0,
          next.alert_min_score,
          next.alert_price_drop_percent,

          req.params.id,
        ],
      );

      const updated = await get(
        "SELECT * FROM radars WHERE id = ?",

        [req.params.id],
      );

      const criteriaSummary =
        await reapplyCriteriaForRadar(updated);

      const strategyChanged = [
        "query",
        "priority_terms",
        "required_terms",
      ].some((key) =>
        Object.prototype.hasOwnProperty.call(
          req.body || {},
          key,
        ),
      );

      const searchPlan = strategyChanged
        ? await searchPlanner.regeneratePlan(updated)
        : await searchPlanner.ensurePlan(updated);

      res.json({
        ...updated,
        criteria_summary: criteriaSummary,
        search_plan_count: searchPlan.length,
      });
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   SEARCH PLANNER
========================= */

app.get("/api/radars/:id/search-plan", async (req, res) => {
  try {
    const radar = await get(
      "SELECT * FROM radars WHERE id = ?",
      [req.params.id],
    );

    if (!radar) {
      return res.status(404).json({
        error: "Radar não encontrado.",
      });
    }

    const rows = await searchPlanner.ensurePlan(radar);
    const selected =
      await searchPlanner.selectedQueries(radar, 8);
    const selectedIds = new Set(
      selected.rows.map((row) => Number(row.id)),
    );

    res.json({
      radar_id: radar.id,
      visual_search_active: Boolean(
        radar.reference_image_path,
      ),
      exploration_count:
        Number(selected.exploration_count || 0),
      queries: rows.map((row) => ({
        ...row,
        next_selected: selectedIds.has(
          Number(row.id),
        ),
      })),
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
    });
  }
});

app.post(
  "/api/radars/:id/search-plan/regenerate",
  async (req, res) => {
    try {
      const radar = await get(
        "SELECT * FROM radars WHERE id = ?",
        [req.params.id],
      );

      if (!radar) {
        return res.status(404).json({
          error: "Radar não encontrado.",
        });
      }

      const rows =
        await searchPlanner.regeneratePlan(radar);

      res.json({
        ok: true,
        radar_id: radar.id,
        queries: rows,
      });
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.message,
      });
    }
  },
);

app.post(
  "/api/radars/:id/search-plan/query",
  async (req, res) => {
    try {
      const radar = await get(
        "SELECT id FROM radars WHERE id = ?",
        [req.params.id],
      );

      if (!radar) {
        return res.status(404).json({
          error: "Radar não encontrado.",
        });
      }

      const row = await searchPlanner.addManualQuery(
        radar.id,
        req.body?.query,
      );

      res.status(201).json(row);
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.message,
      });
    }
  },
);

app.patch(
  "/api/radars/:id/search-plan/query/:queryId",
  async (req, res) => {
    try {
      const row = await searchPlanner.setQueryState(
        req.params.id,
        req.params.queryId,
        {
          enabled:
            req.body?.enabled === undefined
              ? undefined
              : Boolean(req.body.enabled),
          baseWeight: req.body?.base_weight,
        },
      );

      res.json(row);
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.message,
      });
    }
  },
);

app.delete(
  "/api/radars/:id/search-plan/query/:queryId",
  async (req, res) => {
    try {
      const row = await get(
        `SELECT *
         FROM radar_search_queries
         WHERE id = ? AND radar_id = ?`,
        [req.params.queryId, req.params.id],
      );

      if (!row) {
        return res.status(404).json({
          error: "Query não encontrada.",
        });
      }

      if (row.origin !== "manual") {
        return res.status(409).json({
          error:
            "Queries automáticas podem ser pausadas; só queries manuais podem ser apagadas.",
        });
      }

      await run(
        `DELETE FROM radar_search_queries
         WHERE id = ? AND radar_id = ?`,
        [req.params.queryId, req.params.id],
      );

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   EXCLUIR RADAR
========================= */

app.delete(
  "/api/radars/:id",

  async (req, res) => {
    try {
      const radar = await get(
        "SELECT * FROM radars WHERE id = ?",

        [req.params.id],
      );

      if (!radar) {
        return res.status(404).json({
          error: "Radar não encontrado.",
        });
      }

      /*
        IMPORTANTE:

        Os anúncios NÃO são apagados.

        Eles ficam salvos,
        mas sem radar associado.
      */

      await run(
        `
        UPDATE listings
        SET radar_id = NULL
        WHERE radar_id = ?
        `,

        [req.params.id],
      );

      if (radar.reference_image_path) {
        await fsp.unlink(radar.reference_image_path).catch(() => {});
      }

      await run(
        "DELETE FROM radar_search_queries WHERE radar_id = ?",
        [req.params.id],
      );

      await run(
        "DELETE FROM radars WHERE id = ?",

        [req.params.id],
      );

      res.json({
        ok: true,
      });
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   RODAR RADAR
========================= */

app.post("/api/radars/:id/run", async (req, res) => {
  try {
    const result = await radarRunner.executeRadarById(req.params.id, {
      trigger: "manual",
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.patch("/api/radars/:id/schedule", async (req, res) => {
  try {
    const radar = await get("SELECT * FROM radars WHERE id = ?", [req.params.id]);
    if (!radar) return res.status(404).json({ error: "Radar não encontrado." });

    const enabled = Boolean(req.body.enabled);
    const interval = Math.max(Number(req.body.interval_minutes) || 240, 60);

    await run(
      `UPDATE radars
       SET schedule_enabled = ?, schedule_interval_minutes = ?,
           next_run_at = CASE
             WHEN ? = 1 THEN datetime('now', '+' || ? || ' minutes')
             ELSE NULL
           END
       WHERE id = ?`,
      [enabled ? 1 : 0, interval, enabled ? 1 : 0, interval, radar.id],
    );

    const updated = await get("SELECT * FROM radars WHERE id = ?", [radar.id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get("/api/desktop/settings", async (_req, res) => {
  try {
    const row = await get("SELECT * FROM desktop_settings WHERE id = 1");
    res.json({
      autostart_enabled: Boolean(row?.autostart_enabled),
      background_enabled: row ? Boolean(row.background_enabled) : true,
      poll_interval_minutes: Number(row?.poll_interval_minutes || 5),
      notify_new_listings: row ? Boolean(row.notify_new_listings) : true,
      notify_price_drops: row ? Boolean(row.notify_price_drops) : true,
      notify_unavailable: row ? Boolean(row.notify_unavailable) : true,
      notify_errors: row ? Boolean(row.notify_errors) : true,
      start_minimized: Boolean(row?.start_minimized),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/desktop/settings", async (req, res) => {
  try {
    const current = await get("SELECT * FROM desktop_settings WHERE id = 1");
    const allowedIntervals = [5, 15, 30, 60];
    const requestedInterval = Number(req.body.poll_interval_minutes);
    const interval = allowedIntervals.includes(requestedInterval)
      ? requestedInterval
      : Number(current?.poll_interval_minutes || 5);

    const asBool = (value, fallback) =>
      value === undefined ? fallback : Boolean(value);

    const next = {
      autostart_enabled: asBool(req.body.autostart_enabled, Boolean(current?.autostart_enabled)),
      background_enabled: asBool(req.body.background_enabled, current ? Boolean(current.background_enabled) : true),
      poll_interval_minutes: interval,
      notify_new_listings: asBool(req.body.notify_new_listings, current ? Boolean(current.notify_new_listings) : true),
      notify_price_drops: asBool(req.body.notify_price_drops, current ? Boolean(current.notify_price_drops) : true),
      notify_unavailable: asBool(req.body.notify_unavailable, current ? Boolean(current.notify_unavailable) : true),
      notify_errors: asBool(req.body.notify_errors, current ? Boolean(current.notify_errors) : true),
      start_minimized: asBool(req.body.start_minimized, Boolean(current?.start_minimized)),
    };

    await run(
      `UPDATE desktop_settings
       SET autostart_enabled = ?,
           background_enabled = ?,
           poll_interval_minutes = ?,
           notify_new_listings = ?,
           notify_price_drops = ?,
           notify_unavailable = ?,
           notify_errors = ?,
           start_minimized = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      [
        next.autostart_enabled ? 1 : 0,
        next.background_enabled ? 1 : 0,
        next.poll_interval_minutes,
        next.notify_new_listings ? 1 : 0,
        next.notify_price_drops ? 1 : 0,
        next.notify_unavailable ? 1 : 0,
        next.notify_errors ? 1 : 0,
        next.start_minimized ? 1 : 0,
      ],
    );

    res.json(next);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/scheduler/status", async (_req, res) => {
  try {
    const due = await get(
      `SELECT COUNT(*) AS count
       FROM radars
       WHERE schedule_enabled = 1
         AND (next_run_at IS NULL OR datetime(next_run_at) <= datetime('now'))`,
    );
    const enabled = await get(
      "SELECT COUNT(*) AS count FROM radars WHERE schedule_enabled = 1",
    );

    const desktopManaged = process.env.RADAR_DESKTOP === "1";

    res.json({
      autonomous_worker: desktopManaged,
      mode: desktopManaged ? "desktop_managed" : "prepared",
      enabled_radars: enabled.count,
      due_radars: due.count,
      note: desktopManaged
        ? "O Radar Desktop verifica os agendamentos em segundo plano pelo system tray."
        : "No servidor web, a execução contínua depende de um worker externo ou cron.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/scheduler/run-due", async (req, res) => {
  try {
    const result = await radarRunner.runDueRadars(req.body?.limit || 5);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/activity", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await all(
      `SELECT
         e.*,
         r.name AS radar_name,
         l.url AS listing_url,
         l.platform AS listing_platform
       FROM activity_events e
       LEFT JOIN radars r ON r.id = e.radar_id
       LEFT JOIN listings l ON l.id = e.listing_id
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`,
      [limit],
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/notifications/summary", async (_req, res) => {
  try {
    const importantTypes = [
      "smart_alert",
      "listing_unavailable",
      "source_error",
      "run_failed",
    ];
    const placeholders = importantTypes.map(() => "?").join(", ");

    const summary = await get(
      `SELECT
         COUNT(*) AS unseen_total,
         SUM(CASE WHEN type = 'smart_alert' THEN 1 ELSE 0 END) AS smart_alerts,
         SUM(
           CASE
             WHEN type = 'smart_alert'
              AND metadata_json LIKE '%"kind":"high_score_new_listing"%'
             THEN 1 ELSE 0
           END
         ) AS new_listings,
         SUM(
           CASE
             WHEN type = 'smart_alert'
              AND metadata_json LIKE '%"kind":"significant_price_drop"%'
             THEN 1 ELSE 0
           END
         ) AS price_drops,
         SUM(CASE WHEN type = 'listing_unavailable' THEN 1 ELSE 0 END) AS unavailable,
         SUM(CASE WHEN type IN ('source_error', 'run_failed') THEN 1 ELSE 0 END) AS errors
       FROM activity_events
       WHERE seen = 0 AND type IN (${placeholders})`,
      importantTypes,
    );

    res.json({
      unseen_total: Number(summary?.unseen_total || 0),
      smart_alerts: Number(summary?.smart_alerts || 0),
      new_listings: Number(summary?.new_listings || 0),
      price_drops: Number(summary?.price_drops || 0),
      unavailable: Number(summary?.unavailable || 0),
      errors: Number(summary?.errors || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/notifications/mark-seen", async (_req, res) => {
  try {
    const result = await run(
      `UPDATE activity_events
       SET seen = 1
       WHERE seen = 0
         AND type IN ('smart_alert', 'listing_unavailable', 'source_error', 'run_failed')`,
    );

    res.json({ ok: true, marked: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/runs", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const rows = await all(
      `SELECT rr.*, r.name AS radar_name
       FROM radar_runs rr
       LEFT JOIN radars r ON r.id = rr.radar_id
       ORDER BY rr.started_at DESC, rr.id DESC
       LIMIT ?`,
      [limit],
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/preferences/status", async (_req, res) => {
  try {
    const rows = await all("SELECT DISTINCT COALESCE(category, 'geral') AS category FROM radars ORDER BY category");
    const categories = rows.length ? rows.map((row) => row.category) : ["geral"];
    const profiles = [];
    for (const category of categories) {
      const profile = await getPreferenceProfile(category);
      profiles.push({
        category,
        positive_count: profile.positive_count,
        negative_count: profile.negative_count,
        total_feedback: profile.total_feedback,
        active: profile.total_feedback > 0,
      });
    }
    res.json({ profiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/preferences/rebuild", async (req, res) => {
  try {
    res.json(await rebuildPreferenceScores(req.body?.category || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/semantic/status", (_req, res) => {
  res.json(semanticStatus());
});

app.get("/api/international-cost/settings", async (_req, res) => {
  try {
    const settings =
      await getInternationalCostSettings();

    let fx = null;
    let fxError = null;

    if (settings.enabled) {
      try {
        const result = await getFxRates();
        fx = {
          source: result.source,
          rates: result.rates,
          cached: Boolean(result.cached),
        };
      } catch (err) {
        fxError = err.message;
      }
    }

    res.json({
      ...settings,
      fx,
      fx_error: fxError,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/international-cost/settings", async (req, res) => {
  try {
    const next =
      await saveInternationalCostSettings({
        enabled:
          req.body.enabled !== undefined
            ? Boolean(req.body.enabled)
            : undefined,
        program:
          req.body.program !== undefined
            ? req.body.program
            : undefined,
        icms_rate_percent:
          req.body.icms_rate_percent !== undefined
            ? req.body.icms_rate_percent
            : undefined,
        handling_fee_brl:
          req.body.handling_fee_brl !== undefined
            ? req.body.handling_fee_brl
            : undefined,
        destination_postal_code:
          req.body.destination_postal_code !== undefined
            ? req.body.destination_postal_code
            : undefined,
      });

    let fx = null;
    let fxError = null;

    if (next.enabled) {
      try {
        const result = await getFxRates();
        fx = {
          source: result.source,
          rates: result.rates,
          cached: Boolean(result.cached),
        };
      } catch (err) {
        fxError = err.message;
      }
    }

    res.json({
      ...next,
      fx,
      fx_error: fxError,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/catalog-discoveries", async (req, res) => {
  try {
    const params = [];
    const filters = [];

    if (req.query.radar_id) {
      filters.push("c.radar_id = ?");
      params.push(req.query.radar_id);
    }

    const where = filters.length
      ? `WHERE ${filters.join(" AND ")}`
      : "";

    const rows = await all(
      `
      SELECT
        c.*,
        r.name AS radar_name
      FROM catalog_discoveries c
      LEFT JOIN radars r ON r.id = c.radar_id
      ${where}
      ORDER BY c.last_seen_at DESC, c.id DESC
      LIMIT 80
      `,
      params,
    );

    res.json(
      rows.map((row) => ({
        ...row,
        metadata: (() => {
          try {
            return row.metadata_json
              ? JSON.parse(row.metadata_json)
              : {};
          } catch {
            return {};
          }
        })(),
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ebay/deletion-config", async (_req, res) => {
  try {
    if (process.env.RADAR_DESKTOP !== "1") {
      return res.status(403).json({
        error: "Abra esta configuração pelo Radar Desktop.",
      });
    }

    const user = await get("SELECT * FROM users LIMIT 1");

    if (!user) {
      return res.status(500).json({
        error: "Usuário local não encontrado.",
      });
    }

    const bridge = await get(
      `SELECT bridge_client_id, bridge_client_key
       FROM connections
       WHERE user_id = ?
         AND provider = 'mercadolivre'
         AND status = 'connected'
       LIMIT 1`,
      [user.id],
    );

    if (
      !bridge?.bridge_client_id ||
      !bridge?.bridge_client_key
    ) {
      return res.status(409).json({
        error:
          "A ponte segura do Desktop não está disponível. Reconecte o Mercado Livre primeiro.",
      });
    }

    const data = await cloudBridgeRequest(
      "/bridge/ebay/deletion-config",
      {},
      {
        clientId: bridge.bridge_client_id,
        clientKey: bridge.bridge_client_key,
      },
    );

    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
    });
  }
});

app.get("/api/ebay/config", async (_req, res) => {
  try {
    const user = await get("SELECT * FROM users LIMIT 1");
    if (!user) return res.json({ configured: false });

    const row = await get(
      `SELECT developer_client_id, marketplace_id, status
       FROM connections
       WHERE user_id = ? AND provider = 'ebay'
       LIMIT 1`,
      [user.id],
    );

    res.json({
      configured: Boolean(
        row?.developer_client_id && row?.status === "connected",
      ),
      client_id: row?.developer_client_id || null,
      marketplace_id: row?.marketplace_id || "EBAY_US",
      status: row?.status || "disconnected",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ebay/configure", async (req, res) => {
  try {
    if (process.env.RADAR_DESKTOP !== "1") {
      return res.status(403).json({
        error: "As credenciais do eBay só podem ser salvas no Radar Desktop.",
      });
    }

    const clientId = String(req.body?.client_id || "").trim();
    const clientSecret = String(req.body?.client_secret || "").trim();
    const marketplaceId = String(
      req.body?.marketplace_id || "EBAY_US",
    ).trim();

    if (clientId.length < 10 || clientSecret.length < 10) {
      return res.status(400).json({
        error: "Informe o Client ID/App ID e o Client Secret/Cert ID do eBay Developer.",
      });
    }

    const allowedMarketplaces = new Set([
      "EBAY_US", "EBAY_GB", "EBAY_DE", "EBAY_AU",
      "EBAY_CA", "EBAY_FR", "EBAY_IT", "EBAY_ES",
    ]);

    if (!allowedMarketplaces.has(marketplaceId)) {
      return res.status(400).json({
        error: "Marketplace do eBay não suportado nesta versão.",
      });
    }

    const validation = await validateEbayCredentials({
      clientId,
      clientSecret,
      marketplaceId,
    });

    if (!validation.ok) {
      return res.status(validation.status || 400).json({
        error: validation.reason || "O eBay rejeitou as credenciais.",
      });
    }

    const user = await get("SELECT * FROM users LIMIT 1");
    if (!user) {
      return res.status(500).json({ error: "Usuário local não encontrado." });
    }

    await run(
      `INSERT INTO connections (
        user_id, provider, provider_username,
        developer_client_id, developer_client_secret, marketplace_id,
        status, updated_at
      ) VALUES (?, 'ebay', ?, ?, ?, ?, 'connected', CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        provider_username = excluded.provider_username,
        developer_client_id = excluded.developer_client_id,
        developer_client_secret = excluded.developer_client_secret,
        marketplace_id = excluded.marketplace_id,
        status = 'connected',
        updated_at = CURRENT_TIMESTAMP`,
      [
        user.id,
        marketplaceId,
        clientId,
        clientSecret,
        marketplaceId,
      ],
    );

    res.json({
      ok: true,
      provider: "ebay",
      marketplace_id: marketplaceId,
      client_id: clientId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sources/status", async (_req, res) => {
  try {
    const user = await get("SELECT * FROM users LIMIT 1");
    const ebayConnection = user
      ? await get(
          `SELECT developer_client_id, developer_client_secret, marketplace_id, status
           FROM connections
           WHERE user_id = ? AND provider = 'ebay'
           LIMIT 1`,
          [user.id],
        )
      : null;

    const ebayCredentials =
      ebayConnection?.status === "connected"
        ? {
            clientId: ebayConnection.developer_client_id,
            clientSecret: ebayConnection.developer_client_secret,
            marketplaceId:
              ebayConnection.marketplace_id || "EBAY_US",
          }
        : null;

    res.json({
      ebay: getEbayStatus(ebayCredentials),
      olx: getOlxStatus(),
      depop: getDepopStatus(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   LISTAR ANÚNCIOS
========================= */

app.get(
  "/api/listings",

  async (req, res) => {
    try {
      const { radar_id, status, search } = req.query;

      const filters = [];

      const params = [];

      if (radar_id === "none") {
        filters.push("l.radar_id IS NULL");
      } else if (radar_id) {
        filters.push("l.radar_id = ?");

        params.push(radar_id);
      }

      if (status && status !== "todos") {
        filters.push("l.status = ?");

        params.push(status);
      }

      if (search) {
        filters.push(`
          (
            l.title LIKE ?
            OR l.platform LIKE ?
            OR l.notes LIKE ?
          )
        `);

        const q = `%${search}%`;

        params.push(q, q, q);
      }

      const where = filters.length
        ? `
            WHERE
            ${filters.join(" AND ")}
          `
        : "";

      const rows = await all(
        `

        SELECT

          l.*,

          r.name
            AS radar_name,

          r.query
            AS radar_query,

          r.max_price
            AS radar_max_price,

          r.priority_terms_json
            AS radar_priority_terms_json,

          r.penalized_terms_json
            AS radar_penalized_terms_json,

          r.required_terms_json
            AS radar_required_terms_json,

          r.exclude_terms_json
            AS radar_exclude_terms_json,

          r.criteria_weight
            AS radar_criteria_weight,

          r.budget_currency
            AS radar_budget_currency,

          (

            SELECT
              ph.price

            FROM price_history ph

            WHERE
              ph.listing_id = l.id

            ORDER BY
              ph.captured_at ASC

            LIMIT 1

          )
            AS first_price

        FROM listings l

        LEFT JOIN radars r

          ON r.id = l.radar_id

        ${where}

        ORDER BY

          CASE l.status

            WHEN 'interessante'
              THEN 1

            WHEN 'novo'
              THEN 2

            WHEN 'descartado'
              THEN 3

            WHEN 'vendido'
              THEN 4

            ELSE 5

          END,

          COALESCE(l.rule_rejected, 0) ASC,
          COALESCE(l.rule_score, 0) DESC,
          COALESCE(l.grail_score, l.hybrid_score, 0) DESC,
          COALESCE(l.hybrid_score, 0) DESC,
          l.updated_at DESC

        `,

        params,
      );

      const internationalSettings =
        await getInternationalCostSettings().catch(
          () => null,
        );

      let fxInfo = null;

      if (
        internationalSettings?.enabled &&
        rows.some((row) =>
          shouldEstimateInternationalCost(row),
        )
      ) {
        try {
          fxInfo = await getFxRates();
        } catch {
          fxInfo = null;
        }
      }

      res.json(
        rows.map((row) => {
          let internationalCost = null;

          if (
            internationalSettings?.enabled &&
            fxInfo?.rates &&
            shouldEstimateInternationalCost(row)
          ) {
            internationalCost =
              estimateBrazilImportCost({
                price: row.current_price,
                currency: row.currency,
                shippingPrice: row.shipping_price,
                shippingCurrency:
                  row.shipping_currency ||
                  row.currency,
                settings: internationalSettings,
                rates: fxInfo.rates,
              });

            if (internationalCost) {
              internationalCost.fx_source =
                fxInfo.source || null;
              internationalCost.fx_rate_to_brl =
                Number(
                  fxInfo.rates[
                    String(
                      row.currency || "",
                    ).toUpperCase()
                  ],
                ) || null;
              internationalCost.origin_country =
                row.item_country || null;
              internationalCost.shipping_type =
                row.shipping_type || null;
            }
          }

          return {
            ...row,
            ...deriveListingInsights(row),
            international_cost: internationalCost,
          };
        }),
      );
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

function inferBrowserSourceIdentity(platform, url) {
  const platformText = String(platform || "").toLowerCase();
  const urlText = String(url || "");
  const lowerUrl = urlText.toLowerCase();

  let sourceKey = null;
  let externalId = null;

  if (platformText.includes("olx") || lowerUrl.includes("olx.com")) {
    sourceKey = "olx";
    const match = new URL(urlText).pathname.match(/-(\d{8,})(?:\/)?$/);
    if (match) externalId = match[1];
  } else if (
    platformText.includes("mercado livre") ||
    platformText.includes("mercado libre") ||
    lowerUrl.includes("mercadolivre.") ||
    lowerUrl.includes("mercadolibre.")
  ) {
    sourceKey = "mercadolivre";

    const match = urlText.toUpperCase().match(/MLB-?(\d{6,})/);
    if (match) externalId = `MLB${match[1]}`;
  } else if (platformText.includes("ebay") || lowerUrl.includes("ebay.")) {
    sourceKey = "ebay";
    const match = new URL(urlText).pathname.match(
      /\/itm\/(?:[^/]+\/)?(\d{8,})/i,
    );
    if (match) externalId = match[1];
  } else if (
    platformText.includes("enjoei") ||
    lowerUrl.includes("enjoei.com.br")
  ) {
    sourceKey = "enjoei";
    const match = new URL(urlText).pathname.match(
      /\/p\/[^/?#]*-(\d{6,})(?:\/)?$/i,
    );
    if (match) externalId = match[1];
  } else if (
    platformText.includes("facebook") ||
    lowerUrl.includes("facebook.com/marketplace/")
  ) {
    sourceKey = "facebook";
    const match = new URL(urlText).pathname.match(
      /\/marketplace\/item\/(\d+)/i,
    );
    if (match) externalId = match[1];
  } else if (platformText.includes("depop") || lowerUrl.includes("depop.com")) {
    sourceKey = "depop";
    const match = new URL(urlText).pathname.match(
      /\/products\/([^/?#]+)/i,
    );
    if (match) externalId = match[1].toLowerCase();
  } else if (platformText.includes("vinted") || lowerUrl.includes("vinted.")) {
    sourceKey = "vinted";
    const match = new URL(urlText).pathname.match(
      /\/items\/(\d+)/i,
    );
    if (match) externalId = match[1];
  }

  return { sourceKey, externalId };
}

function titleSimilarity(left, right) {
  const a = new Set(normalizeSearchWords(left));
  const b = new Set(normalizeSearchWords(right));

  if (!a.size || !b.size) {
    return String(left || "").trim().toLowerCase() ===
      String(right || "").trim().toLowerCase()
      ? 1
      : 0;
  }

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection += 1;
  }

  return intersection / Math.max(a.size, b.size);
}

function validateAutoCaptureBatch(items) {
  if (!Array.isArray(items) || items.length < 8) {
    return { ok: true };
  }

  const titleCounts = new Map();
  const priceCounts = new Map();

  for (const item of items) {
    const titleKey = normalizeSearchWords(item?.title).join(" ");
    if (titleKey) {
      titleCounts.set(titleKey, (titleCounts.get(titleKey) || 0) + 1);
    }

    const price = Number(item?.current_price ?? item?.price);
    if (Number.isFinite(price)) {
      const key = String(price);
      priceCounts.set(key, (priceCounts.get(key) || 0) + 1);
    }
  }

  const maxTitleCount = Math.max(0, ...titleCounts.values());
  const maxPriceCount = Math.max(0, ...priceCounts.values());
  const titleDominance = maxTitleCount / items.length;
  const priceDominance = maxPriceCount / items.length;
  const titleDiversity = titleCounts.size / items.length;

  if (titleDominance >= 0.45 || titleDiversity <= 0.3) {
    return {
      ok: false,
      reason: "capture_title_collision",
      title_dominance: titleDominance,
      title_diversity: titleDiversity,
    };
  }

  if (priceDominance >= 0.9 && titleDiversity <= 0.55) {
    return {
      ok: false,
      reason: "capture_price_collision",
      price_dominance: priceDominance,
      title_diversity: titleDiversity,
    };
  }

  return { ok: true };
}

/* =========================
   IMPORTAÇÃO ASSISTIDA
========================= */

app.post("/api/import/assisted", async (req, res) => {
  try {
    const radarId = req.body?.radar_id || null;
    const isAutoCapture = req.body?.capture_mode === "auto";
    const autoAssignRequested = Boolean(req.body?.auto_assign) && !radarId;
    const autoAssignRadars = autoAssignRequested
      ? await all("SELECT * FROM radars ORDER BY id ASC")
      : [];
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
    if (!items.length) {
      return res.status(400).json({ error: "Nenhum anúncio válido foi recebido." });
    }

    if (
      isAutoCapture &&
      Number(req.body?.capture_version || 0) < 4
    ) {
      return res.status(409).json({
        error: "Bridge desatualizada. Recarregue a extensão e atualize a página.",
        code: "bridge_reload_required",
      });
    }

    if (isAutoCapture) {
      const guard = validateAutoCaptureBatch(items);
      if (!guard.ok) {
        return res.status(422).json({
          error: "Captura automática rejeitada por inconsistência entre os cards.",
          code: guard.reason,
          guard,
        });
      }
    }

    if (radarId) {
      const radar = await get("SELECT id FROM radars WHERE id = ?", [radarId]);
      if (!radar) return res.status(404).json({ error: "Radar não encontrado." });
    }

    const summary = {
      imported: 0,
      updated: 0,
      auto_assigned: 0,
      price_drops: 0,
      duplicates: 0,
      invalid: 0,
      failed: 0,
      listings: [],
    };

    for (const raw of items) {
      try {
        const title = String(raw?.title || "").trim().slice(0, 300);
        const platform = String(raw?.platform || "Importação assistida").trim().slice(0, 80);
        const url = String(raw?.url || "").trim();
        const imageUrl = raw?.image_url ? String(raw.image_url).trim() : null;
        const currency = String(raw?.currency || "BRL").trim().toUpperCase().slice(0, 8) || "BRL";
        const priceRaw = raw?.current_price ?? raw?.price ?? null;
        const currentPrice = priceRaw === null || priceRaw === "" ? null : Number(priceRaw);

        let parsedUrl;
        try { parsedUrl = new URL(url); } catch { parsedUrl = null; }
        if (!title || !parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol)) {
          summary.invalid += 1;
          continue;
        }

        const { sourceKey, externalId } = inferBrowserSourceIdentity(
          platform,
          url,
        );

        let existing = null;

        if (sourceKey && externalId) {
          existing = await get(
            "SELECT * FROM listings WHERE source_key = ? AND external_id = ?",
            [sourceKey, externalId],
          );
        }

        if (!existing) {
          existing = await get(
            "SELECT * FROM listings WHERE url = ?",
            [url],
          );
        }

        if (existing) {
          if (
            isAutoCapture &&
            existing.title &&
            titleSimilarity(existing.title, title) < 0.35
          ) {
            summary.invalid += 1;
            continue;
          }

          const nextPrice = Number.isFinite(currentPrice) ? currentPrice : null;
          const previousPrice =
            existing.current_price === null || existing.current_price === undefined
              ? null
              : Number(existing.current_price);
          const priceChanged =
            nextPrice !== null &&
            (previousPrice === null || previousPrice !== nextPrice);
          const priceDropped =
            priceChanged &&
            previousPrice !== null &&
            nextPrice < previousPrice &&
            (existing.currency || "BRL") === currency;
          const metadataChanged =
            existing.title !== title ||
            Boolean(imageUrl && existing.image_url !== imageUrl);
          const identityChanged =
            Boolean(sourceKey && existing.source_key !== sourceKey) ||
            Boolean(externalId && existing.external_id !== externalId);
          const wasUnavailable =
            existing.availability_status === "unavailable";

          await run(
            `UPDATE listings
             SET title = ?, platform = ?, image_url = COALESCE(?, image_url),
                 current_price = COALESCE(?, current_price), currency = ?,
                 source_key = COALESCE(?, source_key),
                 external_id = COALESCE(?, external_id),
                 availability_status = 'available',
                 availability_detail = 'seen_in_browser',
                 last_seen_at = CURRENT_TIMESTAMP,
                 last_checked_at = CURRENT_TIMESTAMP,
                 unavailable_since = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              title,
              platform,
              imageUrl,
              nextPrice,
              currency,
              sourceKey,
              externalId,
              existing.id,
            ],
          );

          if (priceChanged) {
            await run(
              "INSERT INTO price_history (listing_id, price) VALUES (?, ?)",
              [existing.id, nextPrice],
            );
          }

          let refreshed = await get(
            "SELECT * FROM listings WHERE id = ?",
            [existing.id],
          );

          let assignment = null;

          if (
            autoAssignRequested &&
            !refreshed.radar_id &&
            autoAssignRadars.length
          ) {
            assignment = await autoAssignListing(
              refreshed,
              autoAssignRadars,
            );

            if (assignment) {
              summary.auto_assigned += 1;
              refreshed = await get(
                "SELECT * FROM listings WHERE id = ?",
                [existing.id],
              );
            }
          }

          if (wasUnavailable) {
            await run(
              `INSERT INTO activity_events
                (radar_id, listing_id, type, title, detail, metadata_json)
               VALUES (?, ?, 'listing_available', ?, ?, ?)`,
              [
                refreshed.radar_id || null,
                existing.id,
                `Anúncio voltou: ${title}`,
                `${platform} voltou a aparecer no navegador.`,
                JSON.stringify({ url, platform, source: sourceKey }),
              ],
            );
          }

          if (priceDropped) {
            await run(
              `INSERT INTO activity_events
                (radar_id, listing_id, type, title, detail, metadata_json)
               VALUES (?, ?, 'price_drop', ?, ?, ?)`,
              [
                refreshed.radar_id || null,
                existing.id,
                `Preço caiu: ${title}`,
                `${currency} ${previousPrice} → ${currency} ${nextPrice}`,
                JSON.stringify({
                  url,
                  platform,
                  previous_price: previousPrice,
                  current_price: nextPrice,
                  currency,
                  source: sourceKey,
                  captured_by_bridge: true,
                }),
              ],
            );

            if (isAutoCapture) {
              await createBridgeSmartPriceDropAlert({
                listing: refreshed,
                previousPrice,
                nextPrice,
                currency,
              });
            }

            summary.price_drops += 1;
          }

          if (
            priceChanged ||
            metadataChanged ||
            identityChanged ||
            wasUnavailable ||
            assignment
          ) {
            summary.updated += 1;
            summary.listings.push(refreshed);
          } else {
            summary.duplicates += 1;
          }

          continue;
        }

        const intelligence = await scoreListingForRadar({
          radarId,
          title,
          imageUrl,
          currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
          currency,
        });

        const notes = [
          "Importação assistida pelo navegador",
          req.body?.source_url ? `Origem: ${String(req.body.source_url).slice(0, 500)}` : null,
        ].filter(Boolean).join(" • ");

        const result = await run(
          `INSERT INTO listings (
            radar_id, title, platform, url, image_url, current_price, currency, status, notes,
            source_key, external_id, availability_status, availability_detail,
            last_seen_at, last_checked_at,
            visual_score, semantic_score, hybrid_score, image_features_json, image_embedding_json,
            preference_score, grail_score
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'novo', ?, ?, ?, 'available', 'seen_in_browser',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?)`,
          [
            radarId, title, platform, url, imageUrl,
            Number.isFinite(currentPrice) ? currentPrice : null, currency, notes,
            sourceKey, externalId,
            intelligence.visual_score, intelligence.semantic_score, intelligence.hybrid_score,
            intelligence.image_features_json, intelligence.image_embedding_json,
            intelligence.preference_score, intelligence.grail_score,
          ],
        );

        if (Number.isFinite(currentPrice)) {
          await run(
            "INSERT INTO price_history (listing_id, price) VALUES (?, ?)",
            [result.id, currentPrice],
          );
        }

        let listing = await get(
          "SELECT * FROM listings WHERE id = ?",
          [result.id],
        );

        if (
          autoAssignRequested &&
          !listing.radar_id &&
          autoAssignRadars.length
        ) {
          const assignment = await autoAssignListing(
            listing,
            autoAssignRadars,
          );

          if (assignment) {
            summary.auto_assigned += 1;
            listing = await get(
              "SELECT * FROM listings WHERE id = ?",
              [result.id],
            );
          }
        }

        if (isAutoCapture) {
          await run(
            `INSERT INTO activity_events
              (radar_id, listing_id, type, title, detail, metadata_json)
             VALUES (?, ?, 'new_listing', ?, ?, ?)`,
            [
              listing.radar_id || null,
              result.id,
              `Novo anúncio: ${title}`,
              `${platform}${
                Number.isFinite(currentPrice)
                  ? ` • ${currency} ${currentPrice}`
                  : ""
              }`,
              JSON.stringify({
                url,
                platform,
                source: sourceKey,
                captured_by_bridge: true,
                auto_assigned: Boolean(listing.radar_id),
              }),
            ],
          );

          await createBridgeSmartAlertForNewListing(
            listing,
          );
        }

        summary.imported += 1;
        summary.listings.push(listing);
      } catch {
        summary.failed += 1;
      }
    }

    if (summary.imported > 0 || summary.updated > 0) {
      const activityType = isAutoCapture
        ? "auto_capture"
        : "assisted_import";
      const activityTitle = isAutoCapture
        ? "Auto-Capture sincronizado"
        : "Importação assistida concluída";

      await run(
        `INSERT INTO activity_events (radar_id, type, title, detail, metadata_json)
         VALUES (?, ?, ?, ?, ?)`,
        [
          radarId,
          activityType,
          activityTitle,
          `${summary.imported} novo(s), ${summary.updated} atualizado(s), ${summary.auto_assigned} auto-organizado(s).`,
          JSON.stringify(summary),
        ],
      );
    }

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   AÇÕES EM MASSA
========================= */

app.post("/api/listings/bulk", async (req, res) => {
  try {
    const ids = [...new Set(
      (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    )].slice(0, 200);

    const action = String(req.body?.action || "").trim();

    if (!ids.length) {
      return res.status(400).json({ error: "Selecione pelo menos um anúncio." });
    }

    const placeholders = ids.map(() => "?").join(",");
    const listings = await all(
      `SELECT * FROM listings WHERE id IN (${placeholders})`,
      ids,
    );

    if (!listings.length) {
      return res.status(404).json({ error: "Nenhum anúncio selecionado foi encontrado." });
    }

    if (action === "delete") {
      await run(
        `DELETE FROM price_history WHERE listing_id IN (${placeholders})`,
        ids,
      );
      await run(
        `DELETE FROM listings WHERE id IN (${placeholders})`,
        ids,
      );

      return res.json({ ok: true, action, affected: listings.length });
    }

    if (action === "status") {
      const status = String(req.body?.status || "").trim();
      const allowed = new Set(["novo", "interessante", "descartado", "vendido"]);

      if (!allowed.has(status)) {
        return res.status(400).json({ error: "Status inválido." });
      }

      await run(
        `UPDATE listings
         SET status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id IN (${placeholders})`,
        [status, ...ids],
      );

      const feedbackChanged =
        ["interessante", "descartado"].includes(status) ||
        listings.some((listing) =>
          ["interessante", "descartado"].includes(listing.status),
        );

      if (feedbackChanged) {
        const categories = await all(
          `SELECT DISTINCT COALESCE(r.category, 'geral') AS category
           FROM listings l
           LEFT JOIN radars r ON r.id = l.radar_id
           WHERE l.id IN (${placeholders})`,
          ids,
        );

        for (const row of categories) {
          await rebuildPreferenceScores(row.category || "geral");
        }
      }

      return res.json({ ok: true, action, affected: listings.length, status });
    }

    if (action === "move") {
      const rawRadarId = req.body?.radar_id;
      const radarId =
        rawRadarId === null || rawRadarId === "" || rawRadarId === "none"
          ? null
          : Number(rawRadarId);

      if (radarId) {
        const radar = await get("SELECT id FROM radars WHERE id = ?", [radarId]);
        if (!radar) {
          return res.status(404).json({ error: "Radar de destino não encontrado." });
        }
      }

      let affected = 0;

      for (const listing of listings) {
        await applyRadarToListing(listing, radarId);
        affected += 1;
      }

      return res.json({ ok: true, action, affected, radar_id: radarId });
    }

    if (action === "auto_assign") {
      const radars = await all("SELECT * FROM radars ORDER BY id ASC");

      if (!radars.length) {
        return res.status(400).json({ error: "Crie pelo menos um radar antes de auto-organizar." });
      }

      const assignments = [];
      let unassigned = 0;

      for (const listing of listings) {
        const assignment = await autoAssignListing(listing, radars);

        if (assignment) {
          assignments.push({
            listing_id: listing.id,
            title: listing.title,
            ...assignment,
          });
        } else {
          unassigned += 1;
        }
      }

      return res.json({
        ok: true,
        action,
        affected: assignments.length,
        unassigned,
        assignments,
      });
    }

    if (action === "rescore") {
      let affected = 0;

      for (const listing of listings) {
        if (!listing.radar_id) continue;
        await applyRadarToListing(listing, listing.radar_id);
        affected += 1;
      }

      return res.json({
        ok: true,
        action,
        affected,
        skipped: listings.length - affected,
      });
    }

    return res.status(400).json({ error: "Ação em massa inválida." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   CRIAR ANÚNCIO
========================= */

app.post(
  "/api/listings",

  async (req, res) => {
    try {
      const {
        radar_id,
        title,
        platform,
        url,
        image_url,
        current_price,
        status,
        notes,
      } = req.body;

      if (!title || !platform || !url) {
        return res.status(400).json({
          error: "Título, plataforma e URL são obrigatórios.",
        });
      }

      const existing = await get(
        `
          SELECT *
          FROM listings
          WHERE url = ?
          `,

        [url.trim()],
      );

      if (existing) {
        return res.status(409).json({
          error: "Esse anúncio já está salvo.",

          listing: existing,
        });
      }

      const intelligence = await scoreListingForRadar({
        radarId: radar_id || null,
        title: title.trim(),
        imageUrl: image_url?.trim() || null,
        currentPrice: current_price,
        currency: "BRL",
      });

      const result = await run(
        `

          INSERT INTO listings
          (
            radar_id,
            title,
            platform,
            url,
            image_url,
            current_price,
            status,
            notes,
            visual_score,
            semantic_score,
            hybrid_score,
            image_features_json,
            image_embedding_json,
            preference_score,
            grail_score
          )

          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )

          `,

        [
          radar_id || null,

          title.trim(),

          platform.trim(),

          url.trim(),

          image_url?.trim() || null,

          current_price === "" ? null : current_price,

          status || "novo",

          notes?.trim() || null,
          intelligence.visual_score,
          intelligence.semantic_score,
          intelligence.hybrid_score,
          intelligence.image_features_json,
          intelligence.image_embedding_json,
          intelligence.preference_score,
          intelligence.grail_score,
        ],
      );

      if (
        current_price !== undefined &&
        current_price !== null &&
        current_price !== ""
      ) {
        await run(
          `
          INSERT INTO price_history
          (
            listing_id,
            price
          )

          VALUES (?, ?)
          `,

          [result.id, current_price],
        );
      }

      const listing = await get(
        `
          SELECT *
          FROM listings
          WHERE id = ?
          `,

        [result.id],
      );

      res.status(201).json(listing);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   EDITAR ANÚNCIO
========================= */

app.patch(
  "/api/listings/:id",

  async (req, res) => {
    try {
      const listing = await get(
        `
          SELECT *
          FROM listings
          WHERE id = ?
          `,

        [req.params.id],
      );

      if (!listing) {
        return res.status(404).json({
          error: "Anúncio não encontrado.",
        });
      }

      const next = {
        radar_id:
          req.body.radar_id !== undefined
            ? req.body.radar_id
            : listing.radar_id,

        title: req.body.title !== undefined ? req.body.title : listing.title,

        platform:
          req.body.platform !== undefined
            ? req.body.platform
            : listing.platform,

        url: req.body.url !== undefined ? req.body.url : listing.url,

        image_url:
          req.body.image_url !== undefined
            ? req.body.image_url
            : listing.image_url,

        current_price:
          req.body.current_price !== undefined
            ? req.body.current_price
            : listing.current_price,

        status:
          req.body.status !== undefined ? req.body.status : listing.status,

        notes: req.body.notes !== undefined ? req.body.notes : listing.notes,
      };

      const priceChanged =
        req.body.current_price !== undefined &&
        Number(req.body.current_price) !== Number(listing.current_price);

      await run(
        `

        UPDATE listings

        SET
          radar_id = ?,
          title = ?,
          platform = ?,
          url = ?,
          image_url = ?,
          current_price = ?,
          status = ?,
          notes = ?,
          updated_at = CURRENT_TIMESTAMP

        WHERE id = ?

        `,

        [
          next.radar_id || null,

          next.title,

          next.platform,

          next.url,

          next.image_url || null,

          next.current_price === "" ? null : next.current_price,

          next.status,

          next.notes || null,

          req.params.id,
        ],
      );

      if (
        next.status !== listing.status &&
        (["interessante", "descartado"].includes(next.status) ||
          ["interessante", "descartado"].includes(listing.status))
      ) {
        const radar = next.radar_id ? await get("SELECT category FROM radars WHERE id = ?", [next.radar_id]) : null;
        await rebuildPreferenceScores(radar?.category || "geral");
      }

      if (
        priceChanged &&
        req.body.current_price !== "" &&
        req.body.current_price !== null
      ) {
        await run(
          `
          INSERT INTO price_history
          (
            listing_id,
            price
          )

          VALUES (?, ?)
          `,

          [req.params.id, req.body.current_price],
        );
      }

      const updated = await get(
        `
          SELECT *
          FROM listings
          WHERE id = ?
          `,

        [req.params.id],
      );

      res.json(updated);
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) {
        return res.status(409).json({
          error: "Já existe um anúncio com essa URL.",
        });
      }

      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   EXCLUIR ANÚNCIO
========================= */

app.delete(
  "/api/listings/:id",

  async (req, res) => {
    try {
      await run(
        `
        DELETE FROM price_history
        WHERE listing_id = ?
        `,

        [req.params.id],
      );

      await run(
        `
        DELETE FROM listings
        WHERE id = ?
        `,

        [req.params.id],
      );

      res.json({
        ok: true,
      });
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   HISTÓRICO DE PREÇO
========================= */

app.get(
  "/api/listings/:id/prices",

  async (req, res) => {
    try {
      const prices = await all(
        `

          SELECT *
          FROM price_history

          WHERE listing_id = ?

          ORDER BY
            captured_at ASC

          `,

        [req.params.id],
      );

      res.json(prices);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);
/* =========================
   OAUTH MERCADO LIVRE
========================= */

const DEFAULT_CLOUD_BRIDGE_URL =
  process.env.RADAR_CLOUD_URL ||
  "https://radar-2-0-littleghoost.fly.dev";

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function bridgeClientKeyHash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

async function requireBridgeClient(req, res, next) {
  try {
    const clientId = String(
      req.headers["x-radar-client-id"] || "",
    );
    const clientKey = String(
      req.headers["x-radar-client-key"] || "",
    );

    if (
      !/^[a-f0-9]{32}$/i.test(clientId) ||
      clientKey.length < 32
    ) {
      return res.status(401).json({
        error: "Credencial do Radar Desktop ausente.",
      });
    }

    const client = await get(
      `SELECT * FROM desktop_bridge_clients
       WHERE id = ? AND revoked_at IS NULL`,
      [clientId],
    );

    if (!client) {
      return res.status(401).json({
        error: "Radar Desktop não reconhecido.",
      });
    }

    const suppliedHash = bridgeClientKeyHash(clientKey);

    if (!safeEqualText(suppliedHash, client.secret_hash)) {
      return res.status(401).json({
        error: "Credencial do Radar Desktop inválida.",
      });
    }

    await run(
      `UPDATE desktop_bridge_clients
       SET last_used_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [client.id],
    );

    req.bridgeClient = client;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function createBridgeOAuthState(pairingId, secret) {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(18).toString("hex");
  const payload = `bridge.${timestamp}.${pairingId}.${nonce}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  return `${payload}.${signature}`;
}

function validateBridgeOAuthState(state, secret) {
  const parts = String(state || "").split(".");

  if (parts.length !== 5 || parts[0] !== "bridge") {
    return null;
  }

  const [, timestamp, pairingId, nonce, signature] = parts;
  const payload = `bridge.${timestamp}.${pairingId}.${nonce}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (signature.length !== expected.length) return null;
  if (
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    )
  ) {
    return null;
  }

  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000) {
    return null;
  }

  return { pairingId };
}

function getMlConfig() {
  const clientId = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  const redirectUri = process.env.ML_REDIRECT_URI;
  const stateSecret = process.env.OAUTH_STATE_SECRET;

  if (!clientId || !clientSecret || !redirectUri || !stateSecret) {
    throw new Error("OAuth do Mercado Livre ainda não está configurado no servidor.");
  }

  return { clientId, clientSecret, redirectUri, stateSecret };
}

function createOAuthState(secret) {
  const payload = `${Date.now()}.${crypto.randomBytes(24).toString("hex")}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

function validateOAuthState(state, secret) {
  if (!state) return false;
  const parts = String(state).split(".");
  if (parts.length !== 3) return false;

  const [timestamp, nonce, signature] = parts;
  const payload = `${timestamp}.${nonce}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  if (signature.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

  const age = Date.now() - Number(timestamp);
  return Number.isFinite(age) && age >= 0 && age <= 10 * 60 * 1000;
}

app.post(
  "/bridge/mercadolivre/start",
  async (_req, res) => {
    try {
      const {
        clientId: mlClientId,
        redirectUri,
        stateSecret,
      } = getMlConfig();

      await run(
        `DELETE FROM oauth_bridge_sessions
         WHERE created_at < datetime('now', '-30 minutes')`,
      );

      await run(
        `DELETE FROM desktop_bridge_clients
         WHERE provider_user_id IS NULL
           AND created_at < datetime('now', '-30 minutes')`,
      );

      const pairingId = crypto.randomBytes(24).toString("hex");
      const bridgeClientId =
        crypto.randomBytes(16).toString("hex");
      const bridgeClientKey =
        base64Url(crypto.randomBytes(32));
      const codeVerifier =
        base64Url(crypto.randomBytes(48));
      const codeChallenge = base64Url(
        crypto.createHash("sha256").update(codeVerifier).digest(),
      );
      const state = createBridgeOAuthState(
        pairingId,
        stateSecret,
      );

      await run(
        `INSERT INTO desktop_bridge_clients
          (id, provider, secret_hash)
         VALUES (?, 'mercadolivre', ?)`,
        [
          bridgeClientId,
          bridgeClientKeyHash(bridgeClientKey),
        ],
      );

      await run(
        `INSERT INTO oauth_bridge_sessions
          (id, provider, client_id, code_verifier, status)
         VALUES (?, 'mercadolivre', ?, ?, 'pending')`,
        [pairingId, bridgeClientId, codeVerifier],
      );

      const url = new URL(
        "https://auth.mercadolivre.com.br/authorization",
      );
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", mlClientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");

      res.json({
        ok: true,
        pairing_id: pairingId,
        bridge_client_id: bridgeClientId,
        bridge_client_key: bridgeClientKey,
        auth_url: url.toString(),
        expires_in_seconds: 900,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.get(
  "/bridge/mercadolivre/session/:id",
  requireBridgeClient,
  async (req, res) => {
    try {
      const pairingId = String(req.params.id || "");
      if (!/^[a-f0-9]{48}$/i.test(pairingId)) {
        return res.status(400).json({ error: "Pareamento inválido." });
      }

      const session = await get(
        `SELECT * FROM oauth_bridge_sessions
         WHERE id = ? AND provider = 'mercadolivre'`,
        [pairingId],
      );

      if (!session) {
        return res.status(404).json({
          status: "missing",
          error: "Pareamento não encontrado ou já finalizado.",
        });
      }

      if (session.client_id !== req.bridgeClient.id) {
        return res.status(403).json({
          error: "Este pareamento pertence a outro Radar Desktop.",
        });
      }

      const ageMs =
        Date.now() - new Date(`${session.created_at}Z`).getTime();

      if (Number.isFinite(ageMs) && ageMs > 20 * 60 * 1000) {
        await run(
          `UPDATE oauth_bridge_sessions
           SET status = 'expired', access_token = NULL,
               refresh_token = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [pairingId],
        );

        return res.json({ status: "expired" });
      }

      if (session.status === "ready") {
        return res.json({
          status: "ready",
          provider_user_id: session.provider_user_id,
          provider_username: session.provider_username,
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
        });
      }

      res.json({
        status: session.status || "pending",
        error: session.error || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.delete(
  "/bridge/mercadolivre/session/:id",
  requireBridgeClient,
  async (req, res) => {
    try {
      const pairingId = String(req.params.id || "");
      await run(
        `DELETE FROM oauth_bridge_sessions
         WHERE id = ?
           AND provider = 'mercadolivre'
           AND client_id = ?`,
        [pairingId, req.bridgeClient.id],
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.post(
  "/bridge/client/revoke",
  requireBridgeClient,
  async (req, res) => {
    try {
      await run(
        `UPDATE desktop_bridge_clients
         SET revoked_at = CURRENT_TIMESTAMP,
             last_used_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [req.bridgeClient.id],
      );

      await run(
        `DELETE FROM oauth_bridge_sessions
         WHERE client_id = ?`,
        [req.bridgeClient.id],
      );

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.get(
  "/bridge/ebay/deletion-config",
  requireBridgeClient,
  async (_req, res) => {
    try {
      const verificationToken =
        await getEbayDeletionVerificationToken();

      if (!verificationToken) {
        return res.status(503).json({
          error: "Verification token do eBay não disponível.",
        });
      }

      res.json({
        endpoint: EBAY_DELETION_ENDPOINT,
        verification_token: verificationToken,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.post(
  "/bridge/mercadolivre/refresh",
  requireBridgeClient,
  async (req, res) => {
    try {
      const refreshToken = String(req.body?.refresh_token || "").trim();
      if (!refreshToken) {
        return res.status(400).json({ error: "Refresh token ausente." });
      }

      const { clientId, clientSecret } = getMlConfig();
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      });

      const response = await fetch(
        "https://api.mercadolibre.com/oauth/token",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        },
      );

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return res.status(response.status).json({
          error:
            data.message ||
            data.error_description ||
            data.error ||
            "Falha ao renovar token.",
        });
      }

      const expiresAt = data.expires_in
        ? new Date(
            Date.now() + Number(data.expires_in) * 1000,
          ).toISOString()
        : null;

      res.json({
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        expires_at: expiresAt,
        user_id: data.user_id || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.get("/auth/mercadolivre", (_req, res) => {
  try {
    const { clientId, redirectUri, stateSecret } = getMlConfig();
    const state = createOAuthState(stateSecret);
    const url = new URL("https://auth.mercadolivre.com.br/authorization");

    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);

    res.redirect(url.toString());
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/auth/mercadolivre/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const { clientId, clientSecret, redirectUri, stateSecret } = getMlConfig();

    const bridgeState = validateBridgeOAuthState(state, stateSecret);
    const normalState = validateOAuthState(state, stateSecret);

    if (!code || (!bridgeState && !normalState)) {
      return res.status(400).send("Resposta OAuth inválida ou expirada.");
    }

    let bridgeSession = null;

    if (bridgeState) {
      bridgeSession = await get(
        `SELECT * FROM oauth_bridge_sessions
         WHERE id = ? AND provider = 'mercadolivre'`,
        [bridgeState.pairingId],
      );

      if (!bridgeSession || bridgeSession.status !== "pending") {
        return res.status(400).send(
          "Pareamento OAuth não encontrado, expirado ou já utilizado.",
        );
      }
    }

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      redirect_uri: redirectUri,
    });

    if (bridgeSession?.code_verifier) {
      tokenBody.set("code_verifier", bridgeSession.code_verifier);
    }

    const tokenResponse = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: tokenBody,
      },
    );
    const tokenData = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok) {
      const message =
        tokenData.message ||
        tokenData.error_description ||
        tokenData.error ||
        "Falha ao obter token do Mercado Livre.";

      if (bridgeSession) {
        await run(
          `UPDATE oauth_bridge_sessions
           SET status = 'error', error = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [message, bridgeSession.id],
        );
      }

      throw new Error(message);
    }

    const profileResponse = await fetch(
      "https://api.mercadolibre.com/users/me",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          accept: "application/json",
        },
      },
    );
    const profile = await profileResponse.json().catch(() => ({}));

    if (!profileResponse.ok) {
      const message =
        profile.message || "Falha ao carregar perfil do Mercado Livre.";

      if (bridgeSession) {
        await run(
          `UPDATE oauth_bridge_sessions
           SET status = 'error', error = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [message, bridgeSession.id],
        );
      }

      throw new Error(message);
    }

    const expiresAt = tokenData.expires_in
      ? new Date(
          Date.now() + Number(tokenData.expires_in) * 1000,
        ).toISOString()
      : null;

    const providerUserId = String(
      tokenData.user_id || profile.id || "",
    );
    const providerUsername =
      profile.nickname || profile.email || null;
    if (bridgeSession) {
      await run(
        `UPDATE oauth_bridge_sessions
         SET status = 'ready',
             access_token = ?,
             refresh_token = ?,
             expires_at = ?,
             provider_user_id = ?,
             provider_username = ?,
             error = NULL,
             code_verifier = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          tokenData.access_token,
          tokenData.refresh_token || null,
          expiresAt,
          providerUserId,
          providerUsername,
          bridgeSession.id,
        ],
      );

      if (bridgeSession.client_id) {
        await run(
          `UPDATE desktop_bridge_clients
           SET provider_user_id = ?,
               last_used_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [providerUserId, bridgeSession.client_id],
        );
      }

      const safeUsername = String(providerUsername || "sua conta")
        .replace(/[<>&"]/g, "");

      return res
        .status(200)
        .type("html")
        .send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mercado Livre conectado</title>
<style>
body{margin:0;background:#0d0d10;color:#f4f4f5;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:520px;padding:32px;text-align:center;border:1px solid #2c2c34;border-radius:20px;background:#15151a}
h1{margin:0 0 12px;font-size:28px}p{color:#aaaab4;line-height:1.55}
strong{color:#7ce7a5}
</style>
</head>
<body>
<main>
<h1>Mercado Livre conectado ✅</h1>
<p>A autorização foi concluída para <strong>${safeUsername}</strong>.</p>
<p>Você já pode fechar esta aba. O Radar 2.0 Desktop vai concluir o pareamento automaticamente.</p>
</main>
</body>
</html>`);
    }
    const user = await get("SELECT * FROM users LIMIT 1");
    if (!user) {
      throw new Error("Usuário local não encontrado.");
    }

    await run(
      `INSERT INTO connections (
        user_id, provider, provider_user_id, provider_username,
        access_token, refresh_token, expires_at, status, updated_at
      ) VALUES (?, 'mercadolivre', ?, ?, ?, ?, ?, 'connected', CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        provider_user_id = excluded.provider_user_id,
        provider_username = excluded.provider_username,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        status = 'connected',
        updated_at = CURRENT_TIMESTAMP`,
      [
        user.id,
        providerUserId,
        providerUsername,
        tokenData.access_token,
        tokenData.refresh_token || null,
        expiresAt,
      ],
    );

    res.redirect("/?connected=mercadolivre");
  } catch (err) {
    console.error("Erro OAuth Mercado Livre:", err);
    res.status(500).send(`Erro ao conectar Mercado Livre: ${err.message}`);
  }
});

/* =========================
   TOKEN MERCADO LIVRE
========================= */

function openTrustedDesktopUrl(rawUrl) {
  if (process.env.RADAR_DESKTOP !== "1") {
    throw new Error("Abertura externa só está disponível no Radar Desktop.");
  }

  const parsed = new URL(String(rawUrl || ""));

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "auth.mercadolivre.com.br"
  ) {
    throw new Error("URL externa não autorizada pelo Radar Desktop.");
  }

  if (process.platform !== "win32") {
    throw new Error("Abertura externa automática ainda só está preparada para Windows.");
  }

  const child = spawn(
    "rundll32.exe",
    ["url.dll,FileProtocolHandler", parsed.toString()],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );

  child.unref();
  return true;
}

async function cloudBridgeRequest(
  pathname,
  options = {},
  credentials = null,
) {
  const headers = {
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(options.headers || {}),
  };

  if (credentials?.clientId && credentials?.clientKey) {
    headers["x-radar-client-id"] = credentials.clientId;
    headers["x-radar-client-key"] = credentials.clientKey;
  }

  const response = await fetch(
    DEFAULT_CLOUD_BRIDGE_URL + pathname,
    {
      ...options,
      headers,
    },
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.error ||
        "Servidor de autorização respondeu " + response.status + ".",
    );
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}

async function getValidMercadoLivreConnection(userId) {
  const connection = await get(
    `SELECT * FROM connections WHERE user_id = ? AND provider = 'mercadolivre' LIMIT 1`,
    [userId],
  );

  if (!connection || connection.status !== "connected") {
    return connection;
  }

  const expiresAt = connection.expires_at
    ? new Date(connection.expires_at).getTime()
    : 0;
  const shouldRefresh = !expiresAt || expiresAt - Date.now() <= 5 * 60 * 1000;

  if (!shouldRefresh) {
    return connection;
  }

  if (!connection.refresh_token) {
    await run(
      `UPDATE connections
       SET status = 'reauthorization_required', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [connection.id],
    );
    return { ...connection, status: "reauthorization_required" };
  }

  let data = null;

  if (process.env.RADAR_DESKTOP === "1") {
    if (
      !connection.bridge_client_id ||
      !connection.bridge_client_key
    ) {
      await run(
        `UPDATE connections
         SET status = 'reauthorization_required',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [connection.id],
      );

      return {
        ...connection,
        status: "reauthorization_required",
      };
    }

    try {
      data = await cloudBridgeRequest(
        "/bridge/mercadolivre/refresh",
        {
          method: "POST",
          body: JSON.stringify({
            refresh_token: connection.refresh_token,
          }),
        },
        {
          clientId: connection.bridge_client_id,
          clientKey: connection.bridge_client_key,
        },
      );
    } catch (err) {
      console.error(
        "Falha ao renovar token do Mercado Livre pela ponte:",
        err.message,
      );

      if ([400, 401, 403].includes(Number(err.status))) {
        await run(
          `UPDATE connections
           SET status = 'reauthorization_required',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [connection.id],
        );

        return {
          ...connection,
          status: "reauthorization_required",
        };
      }

      return {
        ...connection,
        status: "temporarily_unavailable",
      };
    }
  } else {
    const { clientId, clientSecret } = getMlConfig();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
    });

    const response = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      },
    );

    data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Falha ao renovar token do Mercado Livre:", data);
      await run(
        `UPDATE connections
         SET status = 'reauthorization_required',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [connection.id],
      );
      return {
        ...connection,
        status: "reauthorization_required",
      };
    }

    if (data.expires_in) {
      data.expires_at = new Date(
        Date.now() + Number(data.expires_in) * 1000,
      ).toISOString();
    }
  }

  const nextExpiresAt =
    data.expires_at ||
    (data.expires_in
      ? new Date(
          Date.now() + Number(data.expires_in) * 1000,
        ).toISOString()
      : null);

  await run(
    `UPDATE connections
     SET access_token = ?, refresh_token = ?, expires_at = ?,
         status = 'connected', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      data.access_token,
      data.refresh_token || connection.refresh_token,
      nextExpiresAt,
      connection.id,
    ],
  );

  return get("SELECT * FROM connections WHERE id = ?", [connection.id]);
}

/* =========================
   PAREAMENTO MERCADO LIVRE DESKTOP
========================= */

app.post("/api/mercadolivre/connect/start", async (_req, res) => {
  try {
    if (process.env.RADAR_DESKTOP !== "1") {
      return res.json({
        ok: true,
        mode: "web",
        auth_url: "/auth/mercadolivre",
      });
    }

    const data = await cloudBridgeRequest(
      "/bridge/mercadolivre/start",
      { method: "POST", body: "{}" },
    );

    if (
      !data.pairing_id ||
      !data.bridge_client_id ||
      !data.bridge_client_key ||
      !data.auth_url
    ) {
      throw new Error(
        "O servidor não conseguiu criar as credenciais de pareamento.",
      );
    }

    await run(
      `DELETE FROM oauth_bridge_sessions
       WHERE provider = 'mercadolivre_desktop'`,
    );

    await run(
      `INSERT INTO oauth_bridge_sessions
        (id, provider, client_id, client_key, status)
       VALUES (?, 'mercadolivre_desktop', ?, ?, 'pending')`,
      [
        data.pairing_id,
        data.bridge_client_id,
        data.bridge_client_key,
      ],
    );

    openTrustedDesktopUrl(data.auth_url);

    res.json({
      ok: true,
      mode: "desktop_bridge",
      pairing_id: data.pairing_id,
      browser_opened: true,
      expires_in_seconds: data.expires_in_seconds || 900,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/mercadolivre/connect/status", async (req, res) => {
  try {
    const pairingId = String(req.query.pairing_id || "");

    if (!/^[a-f0-9]{48}$/i.test(pairingId)) {
      return res.status(400).json({ error: "Pareamento inválido." });
    }

    const localSession = await get(
      `SELECT * FROM oauth_bridge_sessions
       WHERE id = ? AND provider = 'mercadolivre_desktop'`,
      [pairingId],
    );

    if (
      !localSession ||
      !localSession.client_id ||
      !localSession.client_key
    ) {
      return res.json({ status: "missing" });
    }

    const bridgeCredentials = {
      clientId: localSession.client_id,
      clientKey: localSession.client_key,
    };

    const data = await cloudBridgeRequest(
      `/bridge/mercadolivre/session/${pairingId}`,
      {},
      bridgeCredentials,
    );

    if (data.status !== "ready") {
      return res.json({
        status: data.status || "pending",
        error: data.error || null,
      });
    }

    if (!data.access_token) {
      return res.status(502).json({
        error: "O servidor concluiu a autorização sem retornar um token.",
      });
    }

    const user = await get("SELECT * FROM users LIMIT 1");
    if (!user) {
      return res.status(500).json({ error: "Usuário local não encontrado." });
    }

    await run(
      `INSERT INTO connections (
        user_id, provider, provider_user_id, provider_username,
        access_token, refresh_token, expires_at,
        bridge_client_id, bridge_client_key,
        status, updated_at
      ) VALUES (?, 'mercadolivre', ?, ?, ?, ?, ?, ?, ?, 'connected', CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        provider_user_id = excluded.provider_user_id,
        provider_username = excluded.provider_username,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        bridge_client_id = excluded.bridge_client_id,
        bridge_client_key = excluded.bridge_client_key,
        status = 'connected',
        updated_at = CURRENT_TIMESTAMP`,
      [
        user.id,
        data.provider_user_id || null,
        data.provider_username || null,
        data.access_token,
        data.refresh_token || null,
        data.expires_at || null,
        localSession.client_id,
        localSession.client_key,
      ],
    );

    cloudBridgeRequest(
      `/bridge/mercadolivre/session/${pairingId}`,
      { method: "DELETE" },
      bridgeCredentials,
    ).catch(() => {});

    await run(
      `DELETE FROM oauth_bridge_sessions
       WHERE id = ? AND provider = 'mercadolivre_desktop'`,
      [pairingId],
    );

    res.json({
      status: "connected",
      provider: "mercadolivre",
      provider_username: data.provider_username || null,
      expires_at: data.expires_at || null,
    });
  } catch (err) {
    if (err.status === 404) {
      return res.json({ status: "missing" });
    }

    res.status(err.status || 500).json({ error: err.message });
  }
});

/* =========================
   IMPORTAR ITEM MERCADO LIVRE
========================= */

app.get("/api/mercadolivre/item", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "").trim();
    const match = rawUrl.match(/MLB-?(\d{6,})/i);

    if (!match) {
      return res.status(400).json({
        error: "Não encontrei um ID de anúncio MLB nesse link.",
      });
    }

    const itemId = `MLB${match[1]}`;
    const user = await get("SELECT * FROM users LIMIT 1");
    if (!user) {
      return res.status(500).json({ error: "Usuário local não encontrado." });
    }

    const connection = await getValidMercadoLivreConnection(user.id);
    if (!connection || connection.status !== "connected") {
      return res.status(409).json({
        error: "Conecte sua conta do Mercado Livre antes de importar anúncios.",
      });
    }

    const response = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
      headers: {
        Authorization: `Bearer ${connection.access_token}`,
        accept: "application/json",
      },
    });

    const item = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: item.message || item.error || "Não consegui carregar esse anúncio.",
      });
    }

    const picture =
      item.pictures?.[0]?.secure_url ||
      item.pictures?.[0]?.url ||
      item.secure_thumbnail ||
      item.thumbnail ||
      null;

    res.json({
      id: item.id,
      title: item.title,
      platform: "Mercado Livre",
      current_price: item.price ?? null,
      url: item.permalink || rawUrl,
      image_url: picture,
      status: item.status || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   CONEXÕES
========================= */

app.get(
  "/api/connections",

  async (_req, res) => {
    try {
      const user = await get("SELECT * FROM users LIMIT 1");

      if (!user) {
        return res.json([]);
      }

      await getValidMercadoLivreConnection(user.id);

      const connections = await all(
        `
          SELECT
            id,
            provider,
            provider_username,
            status,
            expires_at,
            updated_at

          FROM connections

          WHERE user_id = ?
          `,
        [user.id],
      );

      const providers = ["olx", "mercadolivre", "ebay", "depop"];
      const ebayStatus = getEbayStatus();
      const olxStatus = getOlxStatus();
      const depopStatus = getDepopStatus();

      const result = providers.map((provider) => {
        const existing = connections.find((item) => item.provider === provider);
        if (existing) return existing;

        let status = "disconnected";
        if (
          provider === "ebay" &&
          !ebayStatus.configured &&
          process.env.RADAR_DESKTOP !== "1"
        ) {
          status = "pending_credentials";
        }
        if (provider === "olx" && !olxStatus.configured) status = "pending_homologation";
        if (provider === "depop" && !depopStatus.configured) status = "partner_access_required";

        return {
          provider,
          status,
          provider_username: null,
          expires_at: null,
        };
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   DESCONECTAR
========================= */

app.delete(
  "/api/connections/:provider",

  async (req, res) => {
    try {
      const user = await get("SELECT * FROM users LIMIT 1");

      if (!user) {
        return res.status(404).json({
          error: "Usuário não encontrado.",
        });
      }

      const existing = await get(
        `SELECT * FROM connections
         WHERE user_id = ? AND provider = ?
         LIMIT 1`,
        [user.id, req.params.provider],
      );

      if (
        process.env.RADAR_DESKTOP === "1" &&
        req.params.provider === "mercadolivre" &&
        existing?.bridge_client_id &&
        existing?.bridge_client_key
      ) {
        await cloudBridgeRequest(
          "/bridge/client/revoke",
          {
            method: "POST",
            body: "{}",
          },
          {
            clientId: existing.bridge_client_id,
            clientKey: existing.bridge_client_key,
          },
        ).catch(() => {});
      }

      await run(
        `
        DELETE FROM connections

        WHERE
          user_id = ?
          AND provider = ?
        `,
        [user.id, req.params.provider],
      );

      res.json({
        ok: true,
      });
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   MOBILE / RELAY
========================= */

app.get("/api/mobile/status", async (_req, res) => {
  try {
    res.json(await mobileDesktopSync.status());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/mobile/pairing", async (_req, res) => {
  try {
    if (process.env.RADAR_DESKTOP !== "1") {
      return res.status(409).json({
        error: "Pareamento mobile só está disponível no Radar Desktop.",
      });
    }

    const result = await mobileDesktopSync.createPairing();
    const qrDataUrl = await QRCode.toDataURL(result.pair_url, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
    });

    res.status(201).json({
      ...result,
      qr_data_url: qrDataUrl,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/mobile/pairing/:id", async (req, res) => {
  try {
    if (process.env.RADAR_DESKTOP !== "1") {
      return res.status(409).json({
        error: "Pareamento mobile só está disponível no Radar Desktop.",
      });
    }

    res.json(
      await mobileDesktopSync.pairingStatus(
        String(req.params.id || ""),
      ),
    );
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/mobile/devices", async (_req, res) => {
  try {
    if (process.env.RADAR_DESKTOP !== "1") {
      return res.json([]);
    }

    res.json(await mobileDesktopSync.listDevices());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/mobile/devices/:id/revoke", async (req, res) => {
  try {
    if (process.env.RADAR_DESKTOP !== "1") {
      return res.status(409).json({
        error: "Gerenciamento mobile só está disponível no Radar Desktop.",
      });
    }

    res.json(
      await mobileDesktopSync.revokeDevice(
        String(req.params.id || ""),
      ),
    );
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/mobile/import-url", async (req, res) => {
  try {
    if (process.env.RADAR_DESKTOP !== "1") {
      return res.status(409).json({
        error: "Importação mobile só está disponível no Radar Desktop.",
      });
    }

    const result = await mobileDesktopSync.importUrl({
      url: req.body?.url,
      radar_id: req.body?.radar_id ?? null,
    });

    await mobileDesktopSync.syncSnapshot().catch(() => {});

    res.status(result.duplicate ? 200 : 201).json({
      ok: true,
      ...result,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/mobile/sync-now", async (_req, res) => {
  try {
    if (process.env.RADAR_DESKTOP !== "1") {
      return res.status(409).json({
        error: "Sincronização mobile só está disponível no Radar Desktop.",
      });
    }

    const [snapshot, commands] = await Promise.all([
      mobileDesktopSync.syncSnapshot(),
      mobileDesktopSync.pollCommands(),
    ]);

    res.json({
      ok: true,
      snapshot,
      commands_processed: Array.isArray(commands)
        ? commands.length
        : 0,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* =========================
   SITE
========================= */

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

/* =========================
   INICIAR SERVIDOR
========================= */

app.listen(
  PORT,

  () => {
    console.log(`Radar 2.0 rodando em http://localhost:${PORT}`);
    mobileDesktopSync.start();
  },
);
