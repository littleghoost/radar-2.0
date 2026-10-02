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

      const hasUserId = columns.some((column) => column.name === "user_id");

      if (!hasUserId) {
        db.run(`
          ALTER TABLE radars
          ADD COLUMN user_id INTEGER
        `);
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
      status TEXT DEFAULT 'disconnected',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(user_id, provider)
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
