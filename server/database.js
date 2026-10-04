const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "data", "radar.db");

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  /* =========================
     USUÁRIOS
  ========================= */

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      password_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  /* =========================
     RADARES
  ========================= */

  db.run(`
    CREATE TABLE IF NOT EXISTS radars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      max_price REAL,
      category TEXT DEFAULT 'geral',
      schedule_enabled INTEGER DEFAULT 0,
      schedule_interval_minutes INTEGER DEFAULT 240,
      next_run_at DATETIME,
      visual_enabled INTEGER DEFAULT 0,
      visual_weight INTEGER DEFAULT 70,
      min_visual_similarity REAL DEFAULT 0.45,
      reference_image_path TEXT,
      reference_features_json TEXT,
      semantic_enabled INTEGER DEFAULT 1,
      semantic_weight INTEGER DEFAULT 70,
      reference_embedding_json TEXT,
      semantic_model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  /* =========================
     MIGRAÇÃO PARA BANCOS ANTIGOS
  ========================= */

  db.all(
    "PRAGMA table_info(radars)",

    (err, columns) => {
      if (err) {
        console.error(err);
        return;
      }

      const names = new Set(columns.map((column) => column.name));

      if (!names.has("user_id")) {
        db.run("ALTER TABLE radars ADD COLUMN user_id INTEGER");
      }
      if (!names.has("schedule_enabled")) {
        db.run("ALTER TABLE radars ADD COLUMN schedule_enabled INTEGER DEFAULT 0");
      }
      if (!names.has("schedule_interval_minutes")) {
        db.run("ALTER TABLE radars ADD COLUMN schedule_interval_minutes INTEGER DEFAULT 240");
      }
      if (!names.has("next_run_at")) {
        db.run("ALTER TABLE radars ADD COLUMN next_run_at DATETIME");
      }
      if (!names.has("visual_enabled")) {
        db.run("ALTER TABLE radars ADD COLUMN visual_enabled INTEGER DEFAULT 0");
      }
      if (!names.has("visual_weight")) {
        db.run("ALTER TABLE radars ADD COLUMN visual_weight INTEGER DEFAULT 70");
      }
      if (!names.has("min_visual_similarity")) {
        db.run("ALTER TABLE radars ADD COLUMN min_visual_similarity REAL DEFAULT 0.45");
      }
      if (!names.has("reference_image_path")) {
        db.run("ALTER TABLE radars ADD COLUMN reference_image_path TEXT");
      }
      if (!names.has("reference_features_json")) {
        db.run("ALTER TABLE radars ADD COLUMN reference_features_json TEXT");
      }
      if (!names.has("semantic_enabled")) {
        db.run("ALTER TABLE radars ADD COLUMN semantic_enabled INTEGER DEFAULT 1");
      }
      if (!names.has("semantic_weight")) {
        db.run("ALTER TABLE radars ADD COLUMN semantic_weight INTEGER DEFAULT 70");
      }
      if (!names.has("reference_embedding_json")) {
        db.run("ALTER TABLE radars ADD COLUMN reference_embedding_json TEXT");
      }
      if (!names.has("semantic_model")) {
        db.run("ALTER TABLE radars ADD COLUMN semantic_model TEXT");
      }
    },
  );

  /* =========================
     CONEXÕES
  ========================= */

  db.run(`
    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_user_id TEXT,
      provider_username TEXT,
      access_token TEXT,
      refresh_token TEXT,
      expires_at DATETIME,
      bridge_client_id TEXT,
      bridge_client_key TEXT,
      developer_client_id TEXT,
      developer_client_secret TEXT,
      marketplace_id TEXT,
      status TEXT DEFAULT 'disconnected',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(user_id, provider)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS oauth_bridge_sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      client_id TEXT,
      client_key TEXT,
      code_verifier TEXT,
      status TEXT DEFAULT 'pending',
      access_token TEXT,
      refresh_token TEXT,
      expires_at DATETIME,
      provider_user_id TEXT,
      provider_username TEXT,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS desktop_bridge_clients (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      provider_user_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME
    )
  `);

  db.all(
    "PRAGMA table_info(connections)",
    (err, columns) => {
      if (err) {
        console.error(err);
        return;
      }

      if (!columns.some((column) => column.name === "bridge_client_id")) {
        db.run("ALTER TABLE connections ADD COLUMN bridge_client_id TEXT");
      }
      if (!columns.some((column) => column.name === "bridge_client_key")) {
        db.run("ALTER TABLE connections ADD COLUMN bridge_client_key TEXT");
      }
      if (!columns.some((column) => column.name === "developer_client_id")) {
        db.run("ALTER TABLE connections ADD COLUMN developer_client_id TEXT");
      }
      if (!columns.some((column) => column.name === "developer_client_secret")) {
        db.run("ALTER TABLE connections ADD COLUMN developer_client_secret TEXT");
      }
      if (!columns.some((column) => column.name === "marketplace_id")) {
        db.run("ALTER TABLE connections ADD COLUMN marketplace_id TEXT");
      }
    },
  );

  db.all(
    "PRAGMA table_info(oauth_bridge_sessions)",
    (err, columns) => {
      if (err) {
        console.error(err);
        return;
      }

      if (!columns.some((column) => column.name === "client_id")) {
        db.run("ALTER TABLE oauth_bridge_sessions ADD COLUMN client_id TEXT");
      }
      if (!columns.some((column) => column.name === "client_key")) {
        db.run("ALTER TABLE oauth_bridge_sessions ADD COLUMN client_key TEXT");
      }
    },
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS catalog_discoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      radar_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      image_url TEXT,
      product_status TEXT,
      domain_id TEXT,
      metadata_json TEXT,
      first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(radar_id, source_key, external_id)
    )
  `);

  /* =========================
     ANÚNCIOS
  ========================= */

  db.run(`
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      radar_id INTEGER,
      title TEXT NOT NULL,
      platform TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      image_url TEXT,
      current_price REAL,
      currency TEXT DEFAULT 'BRL',
      status TEXT DEFAULT 'novo',
      notes TEXT,
      visual_score REAL,
      hybrid_score REAL,
      image_features_json TEXT,
      semantic_score REAL,
      image_embedding_json TEXT,
      preference_score REAL,
      grail_score REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.all(
    "PRAGMA table_info(listings)",
    (err, columns) => {
      if (err) {
        console.error(err);
        return;
      }

      const hasCurrency = columns.some((column) => column.name === "currency");
      if (!hasCurrency) {
        db.run("ALTER TABLE listings ADD COLUMN currency TEXT DEFAULT 'BRL'");
      }
      if (!columns.some((column) => column.name === "visual_score")) {
        db.run("ALTER TABLE listings ADD COLUMN visual_score REAL");
      }
      if (!columns.some((column) => column.name === "hybrid_score")) {
        db.run("ALTER TABLE listings ADD COLUMN hybrid_score REAL");
      }
      if (!columns.some((column) => column.name === "image_features_json")) {
        db.run("ALTER TABLE listings ADD COLUMN image_features_json TEXT");
      }
      if (!columns.some((column) => column.name === "semantic_score")) {
        db.run("ALTER TABLE listings ADD COLUMN semantic_score REAL");
      }
      if (!columns.some((column) => column.name === "image_embedding_json")) {
        db.run("ALTER TABLE listings ADD COLUMN image_embedding_json TEXT");
      }
      if (!columns.some((column) => column.name === "preference_score")) {
        db.run("ALTER TABLE listings ADD COLUMN preference_score REAL");
      }
      if (!columns.some((column) => column.name === "grail_score")) {
        db.run("ALTER TABLE listings ADD COLUMN grail_score REAL");
      }
      if (!columns.some((column) => column.name === "source_key")) {
        db.run("ALTER TABLE listings ADD COLUMN source_key TEXT");
      }
      if (!columns.some((column) => column.name === "external_id")) {
        db.run("ALTER TABLE listings ADD COLUMN external_id TEXT");
      }
      if (!columns.some((column) => column.name === "availability_status")) {
        db.run("ALTER TABLE listings ADD COLUMN availability_status TEXT DEFAULT 'unknown'");
      }
      if (!columns.some((column) => column.name === "availability_detail")) {
        db.run("ALTER TABLE listings ADD COLUMN availability_detail TEXT");
      }
      if (!columns.some((column) => column.name === "last_seen_at")) {
        db.run("ALTER TABLE listings ADD COLUMN last_seen_at DATETIME");
      }
      if (!columns.some((column) => column.name === "last_checked_at")) {
        db.run("ALTER TABLE listings ADD COLUMN last_checked_at DATETIME");
      }
      if (!columns.some((column) => column.name === "unavailable_since")) {
        db.run("ALTER TABLE listings ADD COLUMN unavailable_since DATETIME");
      }
    },
  );

  /* =========================
     EXECUÇÕES DO RADAR
  ========================= */

  db.run(`
    CREATE TABLE IF NOT EXISTS radar_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      radar_id INTEGER NOT NULL,
      status TEXT DEFAULT 'running',
      trigger_type TEXT DEFAULT 'manual',
      sources_total INTEGER DEFAULT 0,
      sources_ok INTEGER DEFAULT 0,
      found_count INTEGER DEFAULT 0,
      added_count INTEGER DEFAULT 0,
      updated_count INTEGER DEFAULT 0,
      error_message TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME
    )
  `);

  db.all(
    "PRAGMA table_info(radar_runs)",
    (err, columns) => {
      if (err) {
        console.error(err);
        return;
      }
      if (!columns.some((column) => column.name === "trigger_type")) {
        db.run("ALTER TABLE radar_runs ADD COLUMN trigger_type TEXT DEFAULT 'manual'");
      }
    },
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      radar_id INTEGER,
      run_id INTEGER,
      listing_id INTEGER,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      metadata_json TEXT,
      seen INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.all(
    "PRAGMA table_info(activity_events)",
    (err, columns) => {
      if (err) {
        console.error(err);
        return;
      }
      if (!columns.some((column) => column.name === "seen")) {
        db.run("ALTER TABLE activity_events ADD COLUMN seen INTEGER DEFAULT 0");
      }
    },
  );

  /* =========================
     HISTÓRICO DE PREÇO
  ========================= */

  db.run(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL,
      price REAL NOT NULL,
      captured_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);


  /* =========================
     CONFIGURAÇÕES DO DESKTOP
  ========================= */

  db.run(`
    CREATE TABLE IF NOT EXISTS desktop_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      autostart_enabled INTEGER DEFAULT 0,
      background_enabled INTEGER DEFAULT 1,
      poll_interval_minutes INTEGER DEFAULT 5,
      notify_new_listings INTEGER DEFAULT 1,
      notify_price_drops INTEGER DEFAULT 1,
      notify_unavailable INTEGER DEFAULT 1,
      notify_errors INTEGER DEFAULT 1,
      start_minimized INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    INSERT OR IGNORE INTO desktop_settings (id)
    VALUES (1)
  `);

  db.all(
    "PRAGMA table_info(desktop_settings)",
    (err, columns) => {
      if (err) {
        console.error(err);
        return;
      }

      if (!columns.some((column) => column.name === "notify_unavailable")) {
        db.run(
          "ALTER TABLE desktop_settings ADD COLUMN notify_unavailable INTEGER DEFAULT 1",
        );
      }
    },
  );

  /* =========================
     USUÁRIO LOCAL
  ========================= */

  db.get(
    `
    SELECT *
    FROM users
    LIMIT 1
    `,

    (err, user) => {
      if (err) {
        console.error(err);
        return;
      }

      if (!user) {
        db.run(
          `
          INSERT INTO users
          (
            name,
            email
          )

          VALUES (?, ?)
          `,

          ["Usuário local", "local@radar.app"],
        );
      }
    },
  );
});

module.exports = db;
