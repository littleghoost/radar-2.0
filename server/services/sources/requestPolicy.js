"use strict";

// Conservative, shared request pacing for official marketplace APIs.
// We never evade a 403/429; a response pauses subsequent calls to that host.
class SourceCooldownError extends Error {
  constructor(hostname, status, remainingMs) {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    super(`A fonte ${hostname} está em pausa automática após HTTP ${status}. Aguarde cerca de ${minutes} minuto(s).`);
    this.name = "SourceCooldownError";
    this.status = status;
    this.rateLimited = true;
    this.retryAfterMs = remainingMs;
  }
}

function retryAfterMilliseconds(header, now = Date.now()) {
  if (!header) return null;
  const raw = String(header).trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    return Math.min(30 * 60_000, Math.max(0, Math.ceil(Number(raw) * 1_000)));
  }
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  return Math.min(30 * 60_000, Math.max(0, date - now));
}

function createSourceRequestPolicy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  minIntervalMs = 500,
  maxConcurrent = 2,
  maxQueue = 80,
  timeoutMs = 15_000,
} = {}) {
  const states = new Map();

  function stateFor(host) {
    if (!states.has(host)) {
      states.set(host, {
        pending: [],
        inFlight: 0,
        lastStartedAt: Number.NEGATIVE_INFINITY,
        blockedUntil: 0,
        blockedStatus: null,
        wakeTimer: null,
      });
    }
    return states.get(host);
  }

  function deferWhenLimited(state, hostname, response) {
    const status = Number(response?.status);
    if (![403, 429, 503].includes(status)) return;
    const indicated = retryAfterMilliseconds(response.headers?.get?.("retry-after"), now());
    const base = status === 403 ? 5 * 60_000 : status === 429 ? 60_000 : 20_000;
    const wait = Math.min(30 * 60_000, Math.max(base, indicated || 0));
    state.blockedUntil = Math.max(state.blockedUntil, now() + wait);
    state.blockedStatus = status;
    if (state.wakeTimer) {
      clearTimeout(state.wakeTimer);
      state.wakeTimer = null;
    }
    // Fail pending requests rather than holding a large queue during cooldown.
    while (state.pending.length) {
      state.pending.shift().reject(new SourceCooldownError(hostname, status, wait));
    }
  }

  function pump(state, hostname) {
    if (state.blockedUntil > now()) {
      const remaining = state.blockedUntil - now();
      while (state.pending.length) {
        state.pending.shift().reject(new SourceCooldownError(
          hostname, state.blockedStatus, remaining,
        ));
      }
      return;
    }

    while (state.pending.length && state.inFlight < maxConcurrent) {
      const wait = state.lastStartedAt + minIntervalMs - now();
      if (wait > 0) {
        if (!state.wakeTimer) {
          state.wakeTimer = setTimeout(() => {
            state.wakeTimer = null;
            pump(state, hostname);
          }, wait);
        }
        return;
      }

      const job = state.pending.shift();
      state.inFlight += 1;
      state.lastStartedAt = now();
      const request = {
        ...job.options,
        signal: job.options.signal
          ? AbortSignal.any([job.options.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      };
      Promise.resolve()
        .then(() => fetchImpl(job.url, request))
        .then((response) => {
          deferWhenLimited(state, hostname, response);
          job.resolve(response);
        }, (error) => job.reject(error))
        .finally(() => {
          state.inFlight -= 1;
          pump(state, hostname);
        });
    }
  }

  async function fetchControlled(url, options = {}) {
    const hostname = new URL(url).hostname.toLowerCase();
    const state = stateFor(hostname);
    if (state.blockedUntil > now()) {
      throw new SourceCooldownError(
        hostname, state.blockedStatus, state.blockedUntil - now(),
      );
    }
    if (state.pending.length >= maxQueue) {
      throw new Error(`Fila de requisições para ${hostname} cheia; aguarde.`);
    }
    return new Promise((resolve, reject) => {
      state.pending.push({ url, options, resolve, reject });
      pump(state, hostname);
    });
  }

  function status(hostname) {
    const state = stateFor(hostname);
    return {
      inFlight: state.inFlight,
      queued: state.pending.length,
      cooldownRemainingMs: Math.max(0, state.blockedUntil - now()),
      blockedStatus: state.blockedUntil > now() ? state.blockedStatus : null,
    };
  }

  return { fetchControlled, status };
}

const sourceRequestPolicy = createSourceRequestPolicy();
async function sourceFetch(url, options) {
  return sourceRequestPolicy.fetchControlled(url, options);
}

module.exports = {
  SourceCooldownError,
  retryAfterMilliseconds,
  createSourceRequestPolicy,
  sourceFetch,
  sourceRequestPolicy,
};
