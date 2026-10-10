"use strict";

function createUpdateShutdownControl() {
  let requested = false;
  let activeRuns = 0;

  function beginRun() {
    if (requested) {
      const error = new Error("Radar pausado para atualização do aplicativo.");
      error.status = 409;
      throw error;
    }
    activeRuns += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      activeRuns = Math.max(0, activeRuns - 1);
    };
  }

  function prepare() {
    requested = true;
    return status();
  }

  function status() {
    return {
      shutdown_requested: requested,
      active_runs: activeRuns,
      ready_for_exit: requested && activeRuns === 0,
    };
  }

  return { beginRun, prepare, status };
}

module.exports = { createUpdateShutdownControl };
