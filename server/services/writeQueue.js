"use strict";

// O Radar usa uma única conexão SQLite compartilhada. A fila garante que a
// escrita de uma requisição não caia no meio da transação de outra.
function createWriteQueue({ db } = {}) {
  if (!db) throw new Error("createWriteQueue precisa de db.");

  let queue = Promise.resolve();

  function enqueue(task) {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function rawRun(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(error) {
        if (error) {
          reject(error);
        } else {
          resolve({
            id: this.lastID,
            changes: this.changes,
          });
        }
      });
    });
  }

  function run(sql, params = []) {
    return enqueue(() => rawRun(sql, params));
  }

  // `work` recebe os helpers e deve usá-los. Não chame `run` da fila aqui
  // dentro: a fila está ocupada pela transação e daria deadlock.
  async function tx(work, helpers = {}) {
    return enqueue(async () => {
      await rawRun("BEGIN IMMEDIATE");

      try {
        const value = await work({ ...helpers, run: rawRun });
        await rawRun("COMMIT");
        return value;
      } catch (error) {
        await rawRun("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  }

  return { run, rawRun, tx };
}

module.exports = { createWriteQueue };
