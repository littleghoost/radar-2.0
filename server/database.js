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
      status TEXT DEFAULT 'novo',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
