"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const sqlite3 = require("sqlite3");
const { createWriteQueue } = require("../server/services/writeQueue");

async function withQueue(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-tx-"));
  const db = new sqlite3.Database(path.join(root, "tx.db"));

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

  const queue = createWriteQueue({ db });
  await queue.run("CREATE TABLE itens (id INTEGER PRIMARY KEY, nome TEXT)");

  return { all, get, queue };
}

test("run devolve lastID e changes", async (t) => {
  const { queue } = await withQueue(t);

  const first = await queue.run("INSERT INTO itens (nome) VALUES (?)", ["a"]);
  assert.equal(first.id, 1);
  assert.equal(first.changes, 1);

  const second = await queue.run("INSERT INTO itens (nome) VALUES (?)", ["b"]);
  assert.equal(second.id, 2);
});

test("tx confirma tudo quando o trabalho termina bem", async (t) => {
  const { queue, all } = await withQueue(t);

  await queue.tx(async ({ run }) => {
    await run("INSERT INTO itens (nome) VALUES (?)", ["um"]);
    await run("INSERT INTO itens (nome) VALUES (?)", ["dois"]);
  });

  assert.equal((await all("SELECT id FROM itens")).length, 2);
});

test("tx desfaz tudo quando o trabalho falha", async (t) => {
  const { queue, all } = await withQueue(t);

  await assert.rejects(
    queue.tx(async ({ run }) => {
      await run("INSERT INTO itens (nome) VALUES (?)", ["parcial"]);
      throw new Error("falha proposital");
    }),
    /falha proposital/,
  );

  assert.equal((await all("SELECT id FROM itens")).length, 0);
});

test("escrita concorrente não entra no meio da transação", async (t) => {
  const { queue, all } = await withQueue(t);

  // A transação insere, espera e falha. A escrita concorrente precisa ficar
  // fora dela e sobreviver ao ROLLBACK.
  const results = await Promise.allSettled([
    queue.tx(async ({ run }) => {
      await run("INSERT INTO itens (nome) VALUES (?)", ["dentro-da-tx"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error("rollback");
    }),
    queue.run("INSERT INTO itens (nome) VALUES (?)", ["fora-da-tx"]),
  ]);

  assert.equal(results[0].status, "rejected");

  const rows = await all("SELECT nome FROM itens ORDER BY id");
  assert.deepEqual(
    rows.map((row) => row.nome),
    ["fora-da-tx"],
  );
});

test("tx injeta helpers de leitura do chamador", async (t) => {
  const { queue, get } = await withQueue(t);
  let consulted = 0;

  await queue.tx(
    async ({ get: txGet, run }) => {
      await run("INSERT INTO itens (nome) VALUES (?)", ["x"]);
      const row = await txGet("SELECT nome FROM itens LIMIT 1");
      assert.equal(row.nome, "x");
      consulted += 1;
    },
    { get },
  );

  assert.equal(consulted, 1);
});
