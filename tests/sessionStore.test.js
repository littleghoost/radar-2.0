"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const sqlite3 = require("sqlite3");
const { createSessionStore } = require("../server/services/sessionStore");

const TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME,
    expires_at DATETIME NOT NULL,
    revoked_at DATETIME,
    ip TEXT,
    user_agent TEXT
  )
`;

async function withStore(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-session-"));
  const db = new sqlite3.Database(path.join(root, "sessions.db"));

  t.after(async () => {
    await new Promise((resolve) => db.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  const all = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))),
    );
  const get = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row))),
    );
  const run = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.run(sql, params, function onRun(error) {
        if (error) return reject(error);
        resolve({ id: this.lastID, changes: this.changes });
      }),
    );

  await run(TABLE);

  return {
    all,
    get,
    run,
    store: createSessionStore({ get, run, secret: "segredo-de-teste", ...options }),
  };
}

test("Sessão criada é válida e o token não é gravado em claro", async (t) => {
  const { store, all } = await withStore(t);

  const token = await store.createSession({ ip: "203.0.113.9" });
  assert.equal(typeof token, "string");
  assert.ok(token.length >= 40);

  assert.equal(await store.isValidSession(token), true);

  const rows = await all("SELECT token_hash FROM sessions");
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.equal(rows[0].token_hash, store.hashToken(token));
});

test("Logout revoga o token e ele para de valer", async (t) => {
  const { store } = await withStore(t);

  const token = await store.createSession();
  assert.equal(await store.isValidSession(token), true);

  assert.equal(await store.revokeSession(token), true);
  assert.equal(await store.isValidSession(token), false);

  // Revogar de novo não altera nada.
  assert.equal(await store.revokeSession(token), false);
});

test("Sessão expirada não autentica", async (t) => {
  const { store } = await withStore(t, { ttlDays: -1 });

  const token = await store.createSession();
  assert.equal(await store.isValidSession(token), false);
});

test("Token desconhecido, vazio ou curto é rejeitado", async (t) => {
  const { store } = await withStore(t);

  assert.equal(await store.isValidSession(""), false);
  assert.equal(await store.isValidSession(undefined), false);
  assert.equal(await store.isValidSession("curto"), false);
  assert.equal(await store.isValidSession("a".repeat(64)), false);
});

test("purgeExpired limpa expiradas e revogadas e preserva as válidas", async (t) => {
  const { store, all, run } = await withStore(t);

  const valid = await store.createSession();
  const revoked = await store.createSession();
  await store.revokeSession(revoked);
  await run(
    `INSERT INTO sessions (token_hash, expires_at)
     VALUES ('hash-antigo', '2000-01-01 00:00:00')`,
  );

  await store.purgeExpired();

  const rows = await all("SELECT token_hash FROM sessions");
  assert.equal(rows.length, 1);
  assert.equal(await store.isValidSession(valid), true);
});

test("revokeAllSessions derruba todas as sessões abertas", async (t) => {
  const { store } = await withStore(t);

  const first = await store.createSession();
  const second = await store.createSession();

  assert.equal(await store.revokeAllSessions(), 2);
  assert.equal(await store.isValidSession(first), false);
  assert.equal(await store.isValidSession(second), false);
});
