const DEFAULT_CLOUD_URL =
  process.env.RADAR_CLOUD_URL ||
  "https://radar-2-0-littleghoost.fly.dev";

const DESKTOP_ID_KEY = "mobile_relay_desktop_id";
const DESKTOP_SECRET_KEY = "mobile_relay_desktop_key";
const LAST_SNAPSHOT_KEY = "mobile_relay_last_snapshot_at";

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
          "SELECT * FROM radars ORDER BY id DESC LIMIT 50",
        ),
        dbAll(
          db,
          `SELECT *
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
      throw new Error(
        "Importação por link será ativada na próxima revisão do Desktop.",
      );
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

    const commandLoop = () => {
      pollCommands().catch((error) => {
        console.error(
          "Mobile relay: falha ao buscar comandos:",
          error.message,
        );
      });
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
    buildSnapshot,
  };
}

module.exports = {
  createMobileDesktopSync,
};
