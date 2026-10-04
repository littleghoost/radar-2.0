const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const db = require("./database");
const { getEbayStatus, getOlxStatus, getDepopStatus } = require("./services/sources");
const { createRadarRunner } = require("./services/radarRunner");
const { extractVisualFeatures, downloadImage, visualSimilarity, hybridScore } = require("./services/visualSimilarity");
const { embedImage, cosineSimilarity: semanticSimilarity, status: semanticStatus, MODEL_ID } = require("./services/semanticVision");
const { buildPreferenceProfile, preferenceScore, grailScore } = require("./services/preferenceLearning");

const app = express();

const PORT = process.env.PORT || 3000;
const IMAGE_DIR = process.env.IMAGE_DIR || path.join(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, "..", "data"), "reference-images");
fs.mkdirSync(IMAGE_DIR, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
  if (isAuthenticated(req)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Faça login para acessar o Radar." });
  }

  return res.redirect("/login");
});

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

const radarRunner = createRadarRunner({
  get,
  all,
  run,
  getValidMercadoLivreConnection,
});

async function scoreListingForRadar({ radarId, title, imageUrl, currentPrice, currency = "BRL" }) {
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

  const hybrid = hybridScore({
    visual: radar.visual_enabled && radar.reference_features_json ? visual : null,
    semantic: radar.semantic_enabled && radar.reference_embedding_json ? semantic : null,
    query: radar.query,
    title,
    price: currentPrice === "" ? null : currentPrice,
    maxPrice: radar.max_price,
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
      const { name, query, max_price, category, visual_enabled, visual_weight, min_visual_similarity, semantic_enabled, semantic_weight } = req.body;

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
          semantic_weight
        )

        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        ],
      );

      const radar = await get(
        "SELECT * FROM radars WHERE id = ?",

        [result.id],
      );

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
          semantic_weight = ?

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

          req.params.id,
        ],
      );

      const updated = await get(
        "SELECT * FROM radars WHERE id = ?",

        [req.params.id],
      );

      res.json(updated);
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

    res.json({
      autonomous_worker: false,
      mode: "prepared",
      enabled_radars: enabled.count,
      due_radars: due.count,
      note: "Execução automática contínua está desligada no Fly. O motor pode ser chamado pelo futuro app desktop, cron ou servidor.",
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
    const importantTypes = ["new_listing", "price_drop", "source_error", "run_failed"];
    const placeholders = importantTypes.map(() => "?").join(", ");

    const summary = await get(
      `SELECT
         COUNT(*) AS unseen_total,
         SUM(CASE WHEN type = 'new_listing' THEN 1 ELSE 0 END) AS new_listings,
         SUM(CASE WHEN type = 'price_drop' THEN 1 ELSE 0 END) AS price_drops,
         SUM(CASE WHEN type IN ('source_error', 'run_failed') THEN 1 ELSE 0 END) AS errors
       FROM activity_events
       WHERE seen = 0 AND type IN (${placeholders})`,
      importantTypes,
    );

    res.json({
      unseen_total: Number(summary?.unseen_total || 0),
      new_listings: Number(summary?.new_listings || 0),
      price_drops: Number(summary?.price_drops || 0),
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
         AND type IN ('new_listing', 'price_drop', 'source_error', 'run_failed')`,
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

app.get("/api/sources/status", (_req, res) => {
  res.json({
    ebay: getEbayStatus(),
    olx: getOlxStatus(),
    depop: getDepopStatus(),
  });
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

      if (radar_id) {
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

          COALESCE(l.grail_score, l.hybrid_score, 0) DESC,
          COALESCE(l.hybrid_score, 0) DESC,
          l.updated_at DESC

        `,

        params,
      );

      res.json(rows);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   IMPORTAÇÃO ASSISTIDA
========================= */

app.post("/api/import/assisted", async (req, res) => {
  try {
    const radarId = req.body?.radar_id || null;
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
    if (!items.length) {
      return res.status(400).json({ error: "Nenhum anúncio válido foi recebido." });
    }

    if (radarId) {
      const radar = await get("SELECT id FROM radars WHERE id = ?", [radarId]);
      if (!radar) return res.status(404).json({ error: "Radar não encontrado." });
    }

    const summary = { imported: 0, updated: 0, duplicates: 0, invalid: 0, failed: 0, listings: [] };

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

        const existing = await get("SELECT id, current_price, title, image_url FROM listings WHERE url = ?", [url]);
        if (existing) {
          const nextPrice = Number.isFinite(currentPrice) ? currentPrice : null;
          const priceChanged = nextPrice !== null && Number(existing.current_price) !== nextPrice;
          const metadataChanged = existing.title !== title || (imageUrl && existing.image_url !== imageUrl);

          await run(
            `UPDATE listings
             SET title = ?, platform = ?, image_url = COALESCE(?, image_url),
                 current_price = COALESCE(?, current_price), currency = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [title, platform, imageUrl, nextPrice, currency, existing.id],
          );

          if (priceChanged) {
            await run("INSERT INTO price_history (listing_id, price) VALUES (?, ?)", [existing.id, nextPrice]);
          }

          if (priceChanged || metadataChanged) {
            summary.updated += 1;
            const refreshed = await get("SELECT * FROM listings WHERE id = ?", [existing.id]);
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
            visual_score, semantic_score, hybrid_score, image_features_json, image_embedding_json,
            preference_score, grail_score
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'novo', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            radarId, title, platform, url, imageUrl,
            Number.isFinite(currentPrice) ? currentPrice : null, currency, notes,
            intelligence.visual_score, intelligence.semantic_score, intelligence.hybrid_score,
            intelligence.image_features_json, intelligence.image_embedding_json,
            intelligence.preference_score, intelligence.grail_score,
          ],
        );

        if (Number.isFinite(currentPrice)) {
          await run("INSERT INTO price_history (listing_id, price) VALUES (?, ?)", [result.id, currentPrice]);
        }

        const listing = await get("SELECT * FROM listings WHERE id = ?", [result.id]);
        summary.imported += 1;
        summary.listings.push(listing);
      } catch {
        summary.failed += 1;
      }
    }

    if (summary.imported > 0 || summary.updated > 0) {
      await run(
        `INSERT INTO activity_events (radar_id, type, title, detail, metadata_json)
         VALUES (?, 'assisted_import', 'Importação assistida concluída', ?, ?)`,
        [radarId, `${summary.imported} importado(s), ${summary.updated} atualizado(s) pelo navegador.`, JSON.stringify(summary)],
      );
    }

    res.json(summary);
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

    if (!code || !validateOAuthState(state, stateSecret)) {
      return res.status(400).send("Resposta OAuth inválida ou expirada.");
    }

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      redirect_uri: redirectUri,
    });

    const tokenResponse = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: tokenBody,
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(tokenData.message || tokenData.error || "Falha ao obter token do Mercado Livre.");
    }

    const profileResponse = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileResponse.json();

    if (!profileResponse.ok) {
      throw new Error(profile.message || "Falha ao carregar perfil do Mercado Livre.");
    }

    const user = await get("SELECT * FROM users LIMIT 1");
    if (!user) throw new Error("Usuário local não encontrado.");

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
      : null;

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
        String(tokenData.user_id || profile.id || ""),
        profile.nickname || profile.email || null,
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

  const { clientId, clientSecret } = getMlConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: connection.refresh_token,
  });

  const response = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Falha ao renovar token do Mercado Livre:", data);
    await run(
      `UPDATE connections
       SET status = 'reauthorization_required', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [connection.id],
    );
    return { ...connection, status: "reauthorization_required" };
  }

  const nextExpiresAt = data.expires_in
    ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
    : null;

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
        if (provider === "ebay" && !ebayStatus.configured) status = "pending_credentials";
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
  },
);
