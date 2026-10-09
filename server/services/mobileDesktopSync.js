const DEFAULT_CLOUD_URL =
  process.env.RADAR_CLOUD_URL ||
  "https://radar-2-0-littleghoost.fly.dev";

const DESKTOP_ID_KEY = "mobile_relay_desktop_id";
const DESKTOP_SECRET_KEY = "mobile_relay_desktop_key";
const LAST_SNAPSHOT_KEY = "mobile_relay_last_snapshot_at";
const LAST_PUSH_EVENT_KEY = "mobile_relay_last_push_event_id";

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

async function getSetting(db, key) {
  const row = await dbGet(
    db,
    "SELECT value FROM integration_settings WHERE key = ?",
    [key],
  );
  return row?.value || null;
}

async function setSetting(db, key, value) {
  await dbRun(
    db,
    `INSERT INTO integration_settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = CURRENT_TIMESTAMP`,
    [key, String(value ?? "")],
  );
}

function platformForUrl(rawUrl) {
  let host = "";
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "Link";
  }

  if (host.endsWith("olx.com.br")) return "OLX";
  if (host.endsWith("enjoei.com.br")) return "Enjoei";
  if (
    host.endsWith("mercadolivre.com.br") ||
    host.endsWith("mercadolibre.com")
  ) {
    return "Mercado Livre";
  }
  if (host.endsWith("depop.com")) return "Depop";
  if (host === "ebay.com" || host.startsWith("ebay.") || host.includes(".ebay.")) return "eBay";
  if (host.endsWith("facebook.com")) return "Facebook Marketplace";
  if (host.endsWith("mercari.com")) return "Mercari";
  if (host.endsWith("buyee.jp")) return "Buyee";

  return host || "Link";
}

function titleFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const parts = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });

    let slug =
      [...parts]
        .reverse()
        .find(
          (part) =>
            part &&
            !/^\d+$/.test(part) &&
            !/^(item|items|produto|product|products|listing|marketplace)$/i.test(part),
        ) || "";

    slug = slug
      .replace(/[-_]+/g, " ")
      .replace(/[0-9]{7,}/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (slug.length >= 4) {
      return slug
        .split(" ")
        .slice(0, 24)
        .join(" ")
        .slice(0, 220);
    }

    return `Link salvo • ${parsed.hostname.replace(/^www\./, "")}`;
  } catch {
    return "Link salvo pelo Radar Mobile";
  }
}

function sourceKeyForPlatform(platform) {
  const value = String(platform || "").toLowerCase();
  if (value.includes("olx")) return "olx";
  if (value.includes("enjoei")) return "enjoei";
  if (value.includes("mercado")) return "mercadolivre";
  if (value.includes("depop")) return "depop";
  if (value.includes("ebay")) return "ebay";
  if (value.includes("facebook")) return "facebook";
  if (value.includes("mercari")) return "mercari";
  if (value.includes("buyee")) return "buyee";
  return null;
}

function createMobileDesktopSync({
  db,
  radarRunner,
  cloudUrl = DEFAULT_CLOUD_URL,
}) {
  const baseUrl = String(cloudUrl || "")
    .trim()
    .replace(/\/$/, "");

  let started = false;
  let commandTimer = null;
  let snapshotTimer = null;
  let busyCommands = false;
  let busySnapshot = false;

  async function credentials() {
    const [desktopId, desktopKey] = await Promise.all([
      getSetting(db, DESKTOP_ID_KEY),
      getSetting(db, DESKTOP_SECRET_KEY),
    ]);

    if (desktopId && desktopKey) {
      return { desktopId, desktopKey };
    }

    const response = await fetch(
      `${baseUrl}/bridge/mobile/desktop/register`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: process.env.COMPUTERNAME
            ? `Radar • ${process.env.COMPUTERNAME}`
            : "Radar Desktop",
        }),
      },
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        data.error ||
          `Relay respondeu ${response.status}`,
      );
    }

    if (!data.desktop_id || !data.desktop_key) {
      throw new Error(
        "Relay não retornou credenciais do Desktop.",
      );
    }

    await setSetting(
      db,
      DESKTOP_ID_KEY,
      data.desktop_id,
    );
    await setSetting(
      db,
      DESKTOP_SECRET_KEY,
      data.desktop_key,
    );

    return {
      desktopId: data.desktop_id,
      desktopKey: data.desktop_key,
    };
  }

  async function relayRequest(path, options = {}) {
    const auth = await credentials();

    const response = await fetch(
      `${baseUrl}${path}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-radar-desktop-id": auth.desktopId,
          "x-radar-desktop-key": auth.desktopKey,
          ...(options.headers || {}),
        },
        ...options,
      },
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        data.error ||
          `Relay respondeu ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    return data;
  }

  async function buildSnapshot() {
    const [radars, listings, activity] =
      await Promise.all([
        dbAll(
          db,
          `SELECT
             id,
             name,
             query,
             max_price,
             category,
             schedule_enabled,
             schedule_interval_minutes,
             next_run_at
           FROM radars
           ORDER BY id DESC
           LIMIT 50`,
        ),
        dbAll(
          db,
          `SELECT
             id,
             radar_id,
             title,
             platform,
             url,
             image_url,
             current_price,
             currency,
             status,
             grail_score,
             hybrid_score,
             rule_score,
             updated_at
           FROM listings
           ORDER BY datetime(updated_at) DESC, id DESC
           LIMIT 250`,
        ),
        dbAll(
          db,
          `SELECT id, radar_id, listing_id, type,
                  title, detail, created_at
           FROM activity_events
           ORDER BY id DESC
           LIMIT 80`,
        ).catch(() => []),
      ]);

    const countByRadar = new Map();
    const interestingByRadar = new Map();

    for (const listing of listings) {
      if (listing.radar_id) {
        countByRadar.set(
          listing.radar_id,
          (countByRadar.get(listing.radar_id) || 0) + 1,
        );

        if (listing.status === "interessante") {
          interestingByRadar.set(
            listing.radar_id,
            (interestingByRadar.get(listing.radar_id) || 0) + 1,
          );
        }
      }
    }

    const radarRows = radars.map((radar) => ({
      ...radar,
      listing_count:
        countByRadar.get(radar.id) || 0,
      interesting_count:
        interestingByRadar.get(radar.id) || 0,
    }));

    return {
      summary: {
        radar_count: radarRows.length,
        listing_count: listings.length,
        interesting_count: listings.filter(
          (listing) =>
            listing.status === "interessante",
        ).length,
        new_count: listings.filter(
          (listing) => listing.status === "novo",
        ).length,
      },
      radars: radarRows,
      listings,
      activity,
    };
  }

  async function syncSnapshot() {
    if (busySnapshot) return null;
    busySnapshot = true;

    try {
      const snapshot = await buildSnapshot();

      const result = await relayRequest(
        "/bridge/mobile/desktop/snapshot",
        {
          method: "PUT",
          body: JSON.stringify(snapshot),
        },
      );

      await setSetting(
        db,
        LAST_SNAPSHOT_KEY,
        new Date().toISOString(),
      );

      return result;
    } finally {
      busySnapshot = false;
    }
  }

  async function heartbeat() {
    return relayRequest(
      "/bridge/mobile/desktop/heartbeat",
      {
        method: "POST",
        body: "{}",
      },
    );
  }

  async function createPairing() {
    return relayRequest(
      "/bridge/mobile/desktop/pairing",
      {
        method: "POST",
        body: "{}",
      },
    );
  }

  async function pairingStatus(pairingId) {
    return relayRequest(
      `/bridge/mobile/desktop/pairing/${encodeURIComponent(
        pairingId,
      )}`,
    );
  }

  async function listDevices() {
    return relayRequest(
      "/bridge/mobile/desktop/devices",
    );
  }

  async function revokeDevice(deviceId) {
    return relayRequest(
      `/bridge/mobile/desktop/devices/${encodeURIComponent(
        deviceId,
      )}/revoke`,
      {
        method: "POST",
        body: "{}",
      },
    );
  }

  async function importUrl(payload = {}) {
    const rawUrl = String(payload.url || "").trim();
    let parsed;

    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error("Link inválido.");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Link precisa usar http ou https.");
    }

    parsed.hash = "";
    const url = parsed.toString().slice(0, 1800);
    const radarId =
      payload.radar_id === null ||
      payload.radar_id === undefined ||
      payload.radar_id === ""
        ? null
        : Number(payload.radar_id);

    if (
      radarId !== null &&
      (!Number.isInteger(radarId) || radarId <= 0)
    ) {
      throw new Error("Radar inválido.");
    }

    if (radarId !== null) {
      const radar = await dbGet(
        db,
        "SELECT id FROM radars WHERE id = ?",
        [radarId],
      );

      if (!radar) {
        throw new Error("Radar não encontrado.");
      }
    }

    const existing = await dbGet(
      db,
      "SELECT * FROM listings WHERE url = ? LIMIT 1",
      [url],
    );

    if (existing) {
      return {
        duplicate: true,
        listing: existing,
      };
    }

    const platform = platformForUrl(url);
    const title = titleFromUrl(url);
    const sourceKey = sourceKeyForPlatform(platform);

    const inserted = await dbRun(
      db,
      `INSERT INTO listings (
         radar_id,
         title,
         platform,
         url,
         status,
         notes,
         source_key,
         availability_status,
         last_seen_at,
         updated_at
       ) VALUES (
         ?, ?, ?, ?, 'novo',
         'Adicionado pelo Radar Mobile',
         ?, 'unknown',
         CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP
       )`,
      [
        radarId,
        title,
        platform,
        url,
        sourceKey,
      ],
    );

    const listing = await dbGet(
      db,
      "SELECT * FROM listings WHERE id = ?",
      [inserted.id],
    );

    await dbRun(
      db,
      `INSERT INTO activity_events
        (radar_id, listing_id, type, title, detail, metadata_json)
       VALUES (?, ?, 'mobile_action', ?, ?, ?)`,
      [
        radarId,
        listing.id,
        "Link adicionado pelo celular",
        `${platform} • ${title}`,
        JSON.stringify({
          source: "mobile_relay",
          action: "import_url",
          url,
        }),
      ],
    ).catch(() => {});

    return {
      duplicate: false,
      listing,
    };
  }

  async function executeCommand(command) {
    const type = String(command.type || "");
    const payload =
      command.payload &&
      typeof command.payload === "object"
        ? command.payload
        : {};

    if (type === "run_radar") {
      const radarId = Number(payload.radar_id);
      const result =
        await radarRunner.executeRadarById(
          radarId,
          { trigger: "mobile" },
        );

      return {
        ok: true,
        result: {
          radar_id: radarId,
          added: Number(result?.added) || 0,
          updated: Number(result?.updated) || 0,
          price_drops:
            Number(result?.priceDrops) || 0,
        },
      };
    }

    if (type === "update_listing_status") {
      const listingId = Number(
        payload.listing_id,
      );
      const status = String(
        payload.status || "",
      );

      const allowed = new Set([
        "novo",
        "interessante",
        "descartado",
        "comprado",
      ]);

      if (
        !Number.isInteger(listingId) ||
        listingId <= 0 ||
        !allowed.has(status)
      ) {
        throw new Error(
          "Comando de status inválido.",
        );
      }

      const result = await dbRun(
        db,
        `UPDATE listings
         SET status = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, listingId],
      );

      if (!result.changes) {
        throw new Error(
          "Anúncio não encontrado.",
        );
      }

      await dbRun(
        db,
        `INSERT INTO activity_events
          (listing_id, type, title, detail, metadata_json)
         VALUES (?, 'mobile_action', ?, ?, ?)`,
        [
          listingId,
          "Status alterado pelo celular",
          `Novo status: ${status}`,
          JSON.stringify({
            source: "mobile_relay",
            status,
          }),
        ],
      ).catch(() => {});

      return {
        ok: true,
        result: {
          listing_id: listingId,
          status,
        },
      };
    }

    if (type === "import_url") {
      return {
        ok: true,
        result: await importUrl(payload),
      };
    }

    throw new Error(
      `Tipo de comando não suportado: ${type}`,
    );
  }

  async function completeCommand(
    commandId,
    result,
  ) {
    return relayRequest(
      `/bridge/mobile/desktop/commands/${encodeURIComponent(
        commandId,
      )}/complete`,
      {
        method: "POST",
        body: JSON.stringify(result),
      },
    );
  }

  async function dispatchSmartAlerts() {
    const cursorRaw = await getSetting(
      db,
      LAST_PUSH_EVENT_KEY,
    );

    if (cursorRaw === null) {
      const latest = await dbGet(
        db,
        `SELECT COALESCE(MAX(id), 0) AS id
         FROM activity_events
         WHERE type = 'smart_alert'`,
      );

      await setSetting(
        db,
        LAST_PUSH_EVENT_KEY,
        Number(latest?.id || 0),
      );

      return [];
    }

    let cursor = Math.max(
      0,
      Number(cursorRaw) || 0,
    );

    const events = await dbAll(
      db,
      `SELECT
         id,
         radar_id,
         listing_id,
         title,
         detail,
         metadata_json,
         created_at
       FROM activity_events
       WHERE type = 'smart_alert'
         AND id > ?
       ORDER BY id ASC
       LIMIT 30`,
      [cursor],
    );

    const delivered = [];

    for (const event of events) {
      let metadata = {};
      try {
        metadata = event.metadata_json
          ? JSON.parse(event.metadata_json)
          : {};
      } catch {
        metadata = {};
      }

      const kind = String(metadata.kind || "");
      if (
        ![
          "high_score_new_listing",
          "significant_price_drop",
        ].includes(kind)
      ) {
        cursor = event.id;
        await setSetting(
          db,
          LAST_PUSH_EVENT_KEY,
          cursor,
        );
        continue;
      }

      const result = await relayRequest(
        "/bridge/mobile/desktop/push",
        {
          method: "POST",
          body: JSON.stringify({
            event_key: `activity:${event.id}`,
            kind,
            title:
              event.title ||
              (kind === "high_score_new_listing"
                ? "Novo grail no Radar"
                : "Queda de preço no Radar"),
            body: event.detail || "",
            url: metadata.url || "/mobile/",
            listing_id: event.listing_id || null,
            radar_id: event.radar_id || null,
          }),
        },
      );

      cursor = event.id;
      await setSetting(
        db,
        LAST_PUSH_EVENT_KEY,
        cursor,
      );

      delivered.push({
        event_id: event.id,
        kind,
        delivered:
          Number(result?.delivered) || 0,
        duplicate: Boolean(result?.duplicate),
      });
    }

    return delivered;
  }

  async function pollCommands() {
    if (busyCommands) return [];
    busyCommands = true;

    try {
      await heartbeat();

      const commands = await relayRequest(
        "/bridge/mobile/desktop/commands/claim",
        {
          method: "POST",
          body: JSON.stringify({ limit: 10 }),
        },
      );

      for (const command of commands) {
        try {
          const result =
            await executeCommand(command);

          await completeCommand(
            command.id,
            result,
          );
        } catch (error) {
          await completeCommand(command.id, {
            ok: false,
            error: String(
              error?.message ||
                "Falha ao executar comando.",
            ).slice(0, 1000),
          }).catch(() => {});
        }
      }

      if (commands.length) {
        await syncSnapshot().catch(() => {});
      }

      return commands;
    } finally {
      busyCommands = false;
    }
  }

  async function status() {
    if (process.env.RADAR_DESKTOP !== "1") {
      return {
        enabled: false,
        configured: false,
        desktop_id: null,
        relay_url: baseUrl,
        relay_ok: false,
        paired_devices: 0,
        devices: [],
        last_snapshot_at: null,
      };
    }

    const [
      desktopId,
      lastSnapshotAt,
    ] = await Promise.all([
      getSetting(db, DESKTOP_ID_KEY),
      getSetting(db, LAST_SNAPSHOT_KEY),
    ]);

    let devices = [];
    let relayOk = false;

    try {
      devices = await listDevices();
      relayOk = true;
    } catch {
      relayOk = false;
    }

    return {
      enabled:
        process.env.RADAR_DESKTOP === "1",
      configured: Boolean(desktopId),
      desktop_id: desktopId,
      relay_url: baseUrl,
      relay_ok: relayOk,
      paired_devices: Array.isArray(devices)
        ? devices.filter(
            (device) => !device.revoked_at,
          ).length
        : 0,
      devices: Array.isArray(devices)
        ? devices
        : [],
      last_snapshot_at: lastSnapshotAt,
    };
  }

  function start() {
    if (
      started ||
      process.env.RADAR_DESKTOP !== "1"
    ) {
      return;
    }

    started = true;

    const commandLoop = async () => {
      try {
        await pollCommands();
        await dispatchSmartAlerts();
      } catch (error) {
        console.error(
          "Mobile relay: falha no loop remoto:",
          error.message,
        );
      }
    };

    const snapshotLoop = () => {
      syncSnapshot().catch((error) => {
        console.error(
          "Mobile relay: falha ao sincronizar snapshot:",
          error.message,
        );
      });
    };

    commandLoop();
    snapshotLoop();

    commandTimer = setInterval(
      commandLoop,
      15_000,
    );
    snapshotTimer = setInterval(
      snapshotLoop,
      60_000,
    );

    commandTimer.unref?.();
    snapshotTimer.unref?.();
  }

  function stop() {
    if (commandTimer) clearInterval(commandTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    commandTimer = null;
    snapshotTimer = null;
    started = false;
  }

  return {
    start,
    stop,
    status,
    heartbeat,
    createPairing,
    pairingStatus,
    listDevices,
    revokeDevice,
    syncSnapshot,
    pollCommands,
    dispatchSmartAlerts,
    buildSnapshot,
    importUrl,
  };
}

module.exports = {
  createMobileDesktopSync,
};
