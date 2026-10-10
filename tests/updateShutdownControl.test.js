"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createUpdateShutdownControl } = require("../server/services/updateShutdownControl");

test("Atualização interrompe novos radares e aguarda os ativos", () => {
  const control = createUpdateShutdownControl();
  const finishOne = control.beginRun();
  const finishTwo = control.beginRun();
  assert.deepEqual(control.status(), {
    shutdown_requested: false,
    active_runs: 2,
    ready_for_exit: false,
  });
  assert.deepEqual(control.prepare(), {
    shutdown_requested: true,
    active_runs: 2,
    ready_for_exit: false,
  });
  assert.throws(() => control.beginRun(), err => err.status === 409);
  finishOne();
  assert.equal(control.status().ready_for_exit, false);
  finishOne();
  assert.equal(control.status().active_runs, 1);
  finishTwo();
  assert.deepEqual(control.status(), {
    shutdown_requested: true,
    active_runs: 0,
    ready_for_exit: true,
  });
});
