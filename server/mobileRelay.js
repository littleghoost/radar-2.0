const crypto = require("crypto");

const PAIRING_TTL_MINUTES = 10;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const ONLINE_WINDOW_SECONDS = 90;
const COMMAND_TYPES = new Set([
  "run_radar",
  "update_listing_status",
  "import_url",
]);
const LISTING_STATUSES = new Set([
  "novo",
  "interessante",
  "descartado",
  "comprado",
]);

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function secretHash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function safeEqualText(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return (
    left.length === right.length &&
    crypto.timingSafeEqual(left, right)
  );
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function initializeMobileRelay(db) {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS mobile_desktop_clients (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        label TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS mobile_pairing_sessions (
        id TEXT PRIMARY KEY,
        desktop_id TEXT NOT NULL,
        pairing_secret_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at DATETIME NOT NULL,
        claimed_device_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS mobile_devices (
        id TEXT PRIMARY KEY,
        desktop_id TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        label TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS mobile_snapshots (
        desktop_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS mobile_commands (
        id TEXT PRIMARY KEY,
        desktop_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        claimed_at DATETIME,
        completed_at DATETIME
      )
    `);

    db.run(
      "CREATE INDEX IF NOT EXISTS idx_mobile_commands_desktop_status ON mobile_commands(desktop_id, status, created_at)",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_mobile_devices_desktop ON mobile_devices(desktop_id, revoked_at)",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_mobile_pairing_desktop ON mobile_pairing_sessions(desktop_id, status, expires_at)",
    );
  });
}

function clientIp(req) {
  return String(
    req.headers["fly-client-ip"] ||
      req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      "unknown",
  )
    .split(",")[0]
    .trim();
}

function createMemoryRateLimiter({
  windowMs = 60_000,
  limit = 30,
} = {}) {
  const buckets = new Map();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = clientIp(req);
    const current = buckets.get(key);

    if (!current || now - current.startedAt >= windowMs) {
      buckets.set(key, { startedAt: now, count: 1 });
      return next();
    }

    current.count += 1;
    if (current.count > limit) {
      return res.status(429).json({
        error: "Muitas tentativas. Aguarde um pouco.",
      });
    }

    if (buckets.size > 500) {
      for (const [bucketKey, value] of buckets) {
        if (now - value.startedAt >= windowMs) {
          buckets.delete(bucketKey);
        }
      }
    }

    next();
  };
}

function sanitizeLabel(value, fallback) {
  const label = String(value || "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return label || fallback;
}

function sanitizeSnapshot(body) {
  const input = body && typeof body === "object" ? body : {};
  const radars = Array.isArray(input.radars)
    ? input.radars.slice(0, 50).map((radar) => ({
        id: Number(radar.id) || null,
        name: String(radar.name || "").slice(0, 160),
        query: String(radar.query || "").slice(0, 1200),
        category: String(radar.category || "geral").slice(0, 80),
        max_price:
          radar.max_price === null || radar.max_price === undefined
            ? null
            : Number(radar.max_price),
        schedule_enabled: Boolean(radar.schedule_enabled),
        schedule_interval_minutes:
          Number(radar.schedule_interval_minutes) || null,
        next_run_at: radar.next_run_at || null,
        listing_count: Number(radar.listing_count) || 0,
        interesting_count: Number(radar.interesting_count) || 0,
        last_run_at: radar.last_run_at || null,
        last_run_status: radar.last_run_status || null,
      }))
    : [];

  const listings = Array.isArray(input.listings)
    ? input.listings.slice(0, 250).map((listing) => ({
        id: Number(listing.id) || null,
        radar_id:
          listing.radar_id === null || listing.radar_id === undefined
            ? null
            : Number(listing.radar_id),
        title: String(listing.title || "").slice(0, 240),
        platform: String(listing.platform || "").slice(0, 80),
        url: String(listing.url || "").slice(0, 1600),
        image_url: String(listing.image_url || "").slice(0, 2200),
        current_price:
          listing.current_price === null ||
          listing.current_price === undefined
            ? null
            : Number(listing.current_price),
        currency: String(listing.currency || "BRL").slice(0, 12),
        status: String(listing.status || "novo").slice(0, 40),
        grail_score:
          listing.grail_score === null ||
          listing.grail_score === undefined
            ? null
            : Number(listing.grail_score),
        hybrid_score:
          listing.hybrid_score === null ||
          listing.hybrid_score === undefined
            ? null
            : Number(listing.hybrid_score),
        rule_score:
          listing.rule_score === null ||
          listing.rule_score === undefined
            ? null
            : Number(listing.rule_score),
        updated_at: listing.updated_at || null,
      }))
    : [];

  const activity = Array.isArray(input.activity)
    ? input.activity.slice(0, 80).map((event) => ({
        id: Number(event.id) || null,
        radar_id:
          event.radar_id === null || event.radar_id === undefined
            ? null
            : Number(event.radar_id),
        listing_id:
          event.listing_id === null || event.listing_id === undefined
            ? null
            : Number(event.listing_id),
        type: String(event.type || "").slice(0, 80),
        title: String(event.title || "").slice(0, 240),
        detail: String(event.detail || "").slice(0, 500),
        created_at: event.created_at || null,
      }))
    : [];

  return {
    version: 1,
    synced_at: new Date().toISOString(),
    summary:
      input.summary && typeof input.summary === "object"
        ? {
            radar_count: Number(input.summary.radar_count) || radars.length,
            listing_count:
              Number(input.summary.listing_count) || listings.length,
            interesting_count:
              Number(input.summary.interesting_count) ||
              listings.filter((item) => item.status === "interessante")
                .length,
            new_count:
              Number(input.summary.new_count) ||
              listings.filter((item) => item.status === "novo").length,
          }
        : {
            radar_count: radars.length,
            listing_count: listings.length,
            interesting_count: listings.filter(
              (item) => item.status === "interessante",
            ).length,
            new_count: listings.filter(
              (item) => item.status === "novo",
            ).length,
          },
    radars,
    listings,
    activity,
  };
}

function validateCommand(type, payload) {
  if (!COMMAND_TYPES.has(type)) {
    return { ok: false, error: "Comando não permitido." };
  }

  const data =
    payload && typeof payload === "object" ? payload : {};

  if (type === "run_radar") {
    const radarId = Number(data.radar_id);
    if (!Number.isInteger(radarId) || radarId <= 0) {
      return { ok: false, error: "Radar inválido." };
    }
    return { ok: true, payload: { radar_id: radarId } };
  }

  if (type === "update_listing_status") {
    const listingId = Number(data.listing_id);
    const status = String(data.status || "");
    if (!Number.isInteger(listingId) || listingId <= 0) {
      return { ok: false, error: "Anúncio inválido." };
    }
    if (!LISTING_STATUSES.has(status)) {
      return { ok: false, error: "Status inválido." };
    }
    return {
      ok: true,
      payload: { listing_id: listingId, status },
    };
  }

  if (type === "import_url") {
    const url = String(data.url || "").trim();
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("protocol");
      }
    } catch {
      return { ok: false, error: "Link inválido." };
    }

    return {
      ok: true,
      payload: {
        url: url.slice(0, 1800),
        radar_id:
          Number.isInteger(Number(data.radar_id)) &&
          Number(data.radar_id) > 0
            ? Number(data.radar_id)
            : null,
      },
    };
  }

  return { ok: false, error: "Comando inválido." };
}

function resolvePublicUrl(req) {
  const configured = String(
    process.env.RADAR_PUBLIC_URL ||
      process.env.RADAR_CLOUD_URL ||
      "",
  )
    .trim()
    .replace(/\/$/, "");

  if (configured) return configured;

  const forwardedProto = String(
    req.headers["x-forwarded-proto"] || "",
  )
    .split(",")[0]
    .trim();
  const protocol =
    forwardedProto || req.protocol || "https";
  const host = req.get("host");
  return `${protocol}://${host}`;
}

function registerMobileRelay(app, db) {
  initializeMobileRelay(db);

  const registerLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    limit: 8,
  });
  const pairingLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    limit: 30,
  });

  async function requireDesktop(req, res, next) {
    try {
      const id = String(
        req.headers["x-radar-desktop-id"] || "",
      );
      const key = String(
        req.headers["x-radar-desktop-key"] || "",
      );

      if (!/^[a-f0-9]{32}$/i.test(id) || key.length < 32) {
        return res.status(401).json({
          error: "Credencial do Radar Desktop ausente.",
        });
      }

      const client = await dbGet(
        db,
        `SELECT * FROM mobile_desktop_clients
         WHERE id = ? AND revoked_at IS NULL`,
        [id],
      );

      if (
        !client ||
        !safeEqualText(secretHash(key), client.secret_hash)
      ) {
        return res.status(401).json({
          error: "Radar Desktop não reconhecido.",
        });
      }

      await dbRun(
        db,
        `UPDATE mobile_desktop_clients
         SET last_seen_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [id],
      );

      req.mobileDesktop = client;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async function requireDevice(req, res, next) {
    try {
      const id = String(
        req.headers["x-radar-mobile-id"] || "",
      );
      const key = String(
        req.headers["x-radar-mobile-key"] || "",
      );

      if (!/^[a-f0-9]{32}$/i.test(id) || key.length < 32) {
        return res.status(401).json({
          error: "Credencial mobile ausente.",
        });
      }

      const device = await dbGet(
        db,
        `SELECT * FROM mobile_devices
         WHERE id = ? AND revoked_at IS NULL`,
        [id],
      );

      if (
        !device ||
        !safeEqualText(secretHash(key), device.secret_hash)
      ) {
        return res.status(401).json({
          error: "Celular não reconhecido.",
        });
      }

      const desktop = await dbGet(
        db,
        `SELECT id FROM mobile_desktop_clients
         WHERE id = ? AND revoked_at IS NULL`,
        [device.desktop_id],
      );

      if (!desktop) {
        return res.status(401).json({
          error: "Radar Desktop vinculado foi revogado.",
        });
      }

      await dbRun(
        db,
        `UPDATE mobile_devices
         SET last_seen_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [id],
      );

      req.mobileDevice = device;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  app.post(
    "/bridge/mobile/desktop/register",
    registerLimiter,
    async (req, res) => {
      try {
        const desktopId = crypto
          .randomBytes(16)
          .toString("hex");
        const desktopKey = base64Url(
          crypto.randomBytes(32),
        );
        const label = sanitizeLabel(
          req.body?.label,
          "Radar Desktop",
        );

        await dbRun(
          db,
          `INSERT INTO mobile_desktop_clients
            (id, secret_hash, label)
           VALUES (?, ?, ?)`,
          [desktopId, secretHash(desktopKey), label],
        );

        res.status(201).json({
          ok: true,
          desktop_id: desktopId,
          desktop_key: desktopKey,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/bridge/mobile/desktop/heartbeat",
    requireDesktop,
    async (_req, res) => {
      res.json({ ok: true, server_time: new Date().toISOString() });
    },
  );

  app.post(
    "/bridge/mobile/desktop/pairing",
    requireDesktop,
    async (req, res) => {
      try {
        await dbRun(
          db,
          `DELETE FROM mobile_pairing_sessions
           WHERE expires_at <= CURRENT_TIMESTAMP
              OR (
                desktop_id = ?
                AND status = 'pending'
              )`,
          [req.mobileDesktop.id],
        );

        const pairingId = crypto
          .randomBytes(16)
          .toString("hex");
        const pairingSecret = base64Url(
          crypto.randomBytes(24),
        );

        await dbRun(
          db,
          `INSERT INTO mobile_pairing_sessions (
             id,
             desktop_id,
             pairing_secret_hash,
             status,
             expires_at
           ) VALUES (
             ?, ?, ?, 'pending',
             datetime('now', '+${PAIRING_TTL_MINUTES} minutes')
           )`,
          [
            pairingId,
            req.mobileDesktop.id,
            secretHash(pairingSecret),
          ],
        );

        const publicUrl = resolvePublicUrl(req);
        const pairUrl =
          `${publicUrl}/mobile/pair.html#` +
          new URLSearchParams({
            id: pairingId,
            secret: pairingSecret,
          }).toString();

        res.status(201).json({
          ok: true,
          pairing_id: pairingId,
          pairing_secret: pairingSecret,
          pair_url: pairUrl,
          expires_in_seconds:
            PAIRING_TTL_MINUTES * 60,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get(
    "/bridge/mobile/desktop/pairing/:id",
    requireDesktop,
    async (req, res) => {
      try {
        const session = await dbGet(
          db,
          `SELECT id, desktop_id, status, expires_at,
                  claimed_device_id, created_at
           FROM mobile_pairing_sessions
           WHERE id = ? AND desktop_id = ?`,
          [req.params.id, req.mobileDesktop.id],
        );

        if (!session) {
          return res.status(404).json({
            status: "missing",
          });
        }

        res.json(session);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/bridge/mobile/pair/:id/claim",
    pairingLimiter,
    async (req, res) => {
      try {
        const pairingSecret = String(
          req.body?.pairing_secret || "",
        );

        if (pairingSecret.length < 24) {
          return res.status(400).json({
            error: "Código de pareamento inválido.",
          });
        }

        const session = await dbGet(
          db,
          `SELECT * FROM mobile_pairing_sessions
           WHERE id = ?`,
          [String(req.params.id || "")],
        );

        if (!session) {
          return res.status(404).json({
            error: "Pareamento não encontrado.",
          });
        }

        if (session.status !== "pending") {
          return res.status(409).json({
            error: "Este pareamento já foi utilizado.",
          });
        }

        const expired = await dbGet(
          db,
          `SELECT
             CASE
               WHEN datetime(?) <= CURRENT_TIMESTAMP THEN 1
               ELSE 0
             END AS expired`,
          [session.expires_at],
        );

        if (expired?.expired) {
          await dbRun(
            db,
            `UPDATE mobile_pairing_sessions
             SET status = 'expired'
             WHERE id = ?`,
            [session.id],
          );
          return res.status(410).json({
            error: "O pareamento expirou. Gere outro no Desktop.",
          });
        }

        if (
          !safeEqualText(
            secretHash(pairingSecret),
            session.pairing_secret_hash,
          )
        ) {
          return res.status(401).json({
            error: "Código de pareamento incorreto.",
          });
        }

        const mobileId = crypto
          .randomBytes(16)
          .toString("hex");
        const mobileKey = base64Url(
          crypto.randomBytes(32),
        );
        const label = sanitizeLabel(
          req.body?.label,
          "Meu celular",
        );

        await dbRun(
          db,
          `INSERT INTO mobile_devices
            (id, desktop_id, secret_hash, label)
           VALUES (?, ?, ?, ?)`,
          [
            mobileId,
            session.desktop_id,
            secretHash(mobileKey),
            label,
          ],
        );

        await dbRun(
          db,
          `UPDATE mobile_pairing_sessions
           SET status = 'claimed',
               claimed_device_id = ?
           WHERE id = ? AND status = 'pending'`,
          [mobileId, session.id],
        );

        res.status(201).json({
          ok: true,
          mobile_id: mobileId,
          mobile_key: mobileKey,
          desktop_id: session.desktop_id,
          relay_url: resolvePublicUrl(req),
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get(
    "/bridge/mobile/desktop/devices",
    requireDesktop,
    async (req, res) => {
      try {
        const rows = await dbAll(
          db,
          `SELECT id, label, created_at, last_seen_at, revoked_at
           FROM mobile_devices
           WHERE desktop_id = ?
           ORDER BY created_at DESC`,
          [req.mobileDesktop.id],
        );
        res.json(rows);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/bridge/mobile/desktop/devices/:id/revoke",
    requireDesktop,
    async (req, res) => {
      try {
        const result = await dbRun(
          db,
          `UPDATE mobile_devices
           SET revoked_at = CURRENT_TIMESTAMP
           WHERE id = ? AND desktop_id = ? AND revoked_at IS NULL`,
          [req.params.id, req.mobileDesktop.id],
        );

        if (!result.changes) {
          return res.status(404).json({
            error: "Celular não encontrado.",
          });
        }

        await dbRun(
          db,
          `UPDATE mobile_commands
           SET status = 'cancelled',
               completed_at = CURRENT_TIMESTAMP,
               error = 'Dispositivo revogado.'
           WHERE device_id = ?
             AND desktop_id = ?
             AND status IN ('pending', 'claimed')`,
          [req.params.id, req.mobileDesktop.id],
        );

        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.put(
    "/bridge/mobile/desktop/snapshot",
    requireDesktop,
    async (req, res) => {
      try {
        const snapshot = sanitizeSnapshot(req.body);
        const encoded = JSON.stringify(snapshot);
        const size = Buffer.byteLength(encoded, "utf8");

        if (size > MAX_SNAPSHOT_BYTES) {
          return res.status(413).json({
            error: "Snapshot maior que o limite permitido.",
          });
        }

        await dbRun(
          db,
          `INSERT INTO mobile_snapshots
            (desktop_id, payload_json, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(desktop_id) DO UPDATE SET
             payload_json = excluded.payload_json,
             updated_at = CURRENT_TIMESTAMP`,
          [req.mobileDesktop.id, encoded],
        );

        res.json({
          ok: true,
          bytes: size,
          synced_at: snapshot.synced_at,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get(
    "/bridge/mobile/device/snapshot",
    requireDevice,
    async (req, res) => {
      try {
        const row = await dbGet(
          db,
          `SELECT payload_json, updated_at
           FROM mobile_snapshots
           WHERE desktop_id = ?`,
          [req.mobileDevice.desktop_id],
        );

        if (!row) {
          return res.json({
            version: 1,
            synced_at: null,
            summary: {
              radar_count: 0,
              listing_count: 0,
              interesting_count: 0,
              new_count: 0,
            },
            radars: [],
            listings: [],
            activity: [],
          });
        }

        const payload = JSON.parse(row.payload_json || "{}");
        res.json({
          ...payload,
          relay_updated_at: row.updated_at,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get(
    "/bridge/mobile/device/status",
    requireDevice,
    async (req, res) => {
      try {
        const desktop = await dbGet(
          db,
          `SELECT id, label, last_seen_at,
                  CASE
                    WHEN last_seen_at >=
                      datetime('now', '-${ONLINE_WINDOW_SECONDS} seconds')
                    THEN 1 ELSE 0
                  END AS online
           FROM mobile_desktop_clients
           WHERE id = ? AND revoked_at IS NULL`,
          [req.mobileDevice.desktop_id],
        );

        res.json({
          desktop_id: desktop?.id || null,
          desktop_label: desktop?.label || "Radar Desktop",
          online: Boolean(desktop?.online),
          last_seen_at: desktop?.last_seen_at || null,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/bridge/mobile/device/commands",
    requireDevice,
    async (req, res) => {
      try {
        const type = String(req.body?.type || "");
        const checked = validateCommand(
          type,
          req.body?.payload,
        );

        if (!checked.ok) {
          return res.status(400).json({
            error: checked.error,
          });
        }

        const commandId = crypto
          .randomBytes(16)
          .toString("hex");

        await dbRun(
          db,
          `INSERT INTO mobile_commands (
             id, desktop_id, device_id,
             type, payload_json, status
           ) VALUES (?, ?, ?, ?, ?, 'pending')`,
          [
            commandId,
            req.mobileDevice.desktop_id,
            req.mobileDevice.id,
            type,
            JSON.stringify(checked.payload),
          ],
        );

        res.status(201).json({
          ok: true,
          command_id: commandId,
          status: "pending",
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get(
    "/bridge/mobile/device/commands",
    requireDevice,
    async (req, res) => {
      try {
        const limit = Math.min(
          Math.max(Number(req.query.limit) || 30, 1),
          100,
        );

        const rows = await dbAll(
          db,
          `SELECT id, type, payload_json, status,
                  result_json, error, created_at,
                  claimed_at, completed_at
           FROM mobile_commands
           WHERE device_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
          [req.mobileDevice.id, limit],
        );

        res.json(
          rows.map((row) => ({
            ...row,
            payload: JSON.parse(row.payload_json || "{}"),
            result: row.result_json
              ? JSON.parse(row.result_json)
              : null,
            payload_json: undefined,
            result_json: undefined,
          })),
        );
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/bridge/mobile/desktop/commands/claim",
    requireDesktop,
    async (req, res) => {
      try {
        const limit = Math.min(
          Math.max(Number(req.body?.limit) || 10, 1),
          30,
        );

        const rows = await dbAll(
          db,
          `SELECT *
           FROM mobile_commands
           WHERE desktop_id = ?
             AND status = 'pending'
           ORDER BY created_at ASC
           LIMIT ?`,
          [req.mobileDesktop.id, limit],
        );

        const claimed = [];
        for (const row of rows) {
          const result = await dbRun(
            db,
            `UPDATE mobile_commands
             SET status = 'claimed',
                 claimed_at = CURRENT_TIMESTAMP
             WHERE id = ?
               AND desktop_id = ?
               AND status = 'pending'`,
            [row.id, req.mobileDesktop.id],
          );

          if (result.changes) {
            claimed.push({
              id: row.id,
              device_id: row.device_id,
              type: row.type,
              payload: JSON.parse(row.payload_json || "{}"),
              created_at: row.created_at,
            });
          }
        }

        res.json(claimed);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/bridge/mobile/desktop/commands/:id/complete",
    requireDesktop,
    async (req, res) => {
      try {
        const success = req.body?.ok !== false;
        const resultJson =
          req.body?.result === undefined
            ? null
            : JSON.stringify(req.body.result);
        const errorText = success
          ? null
          : String(req.body?.error || "Falha no comando.")
              .slice(0, 1000);

        const result = await dbRun(
          db,
          `UPDATE mobile_commands
           SET status = ?,
               result_json = ?,
               error = ?,
               completed_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND desktop_id = ?
             AND status = 'claimed'`,
          [
            success ? "completed" : "failed",
            resultJson,
            errorText,
            req.params.id,
            req.mobileDesktop.id,
          ],
        );

        if (!result.changes) {
          return res.status(404).json({
            error: "Comando não encontrado ou já finalizado.",
          });
        }

        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/bridge/mobile/device/revoke",
    requireDevice,
    async (req, res) => {
      try {
        await dbRun(
          db,
          `UPDATE mobile_devices
           SET revoked_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [req.mobileDevice.id],
        );
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );
}

module.exports = {
  registerMobileRelay,
  initializeMobileRelay,
  sanitizeSnapshot,
  validateCommand,
};
