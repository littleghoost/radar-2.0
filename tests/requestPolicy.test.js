"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSourceRequestPolicy,
  retryAfterMilliseconds,
} = require("../server/services/sources/requestPolicy");

const ENDPOINT = "https://api.ebay.com/buy/browse/v1/item_summary/search";

test("Respeita Retry-After em segundos, datas e ignora valores inválidos", () => {
  const now = Date.parse("2026-10-10T12:00:00.000Z");
  assert.equal(retryAfterMilliseconds("120", now), 120_000);
  assert.equal(retryAfterMilliseconds(new Date(now + 90_000).toUTCString(), now), 90_000);
  assert.equal(retryAfterMilliseconds("not-a-date", now), null);
  assert.equal(retryAfterMilliseconds("4000", now), 30 * 60_000);
});

test("Distribui requisições no tempo e limita simultaneidade por API", async () => {
  let active = 0;
  let peak = 0;
  const starts = [];
  const policy = createSourceRequestPolicy({
    minIntervalMs: 35,
    maxConcurrent: 2,
    fetchImpl: async () => {
      starts.push(Date.now());
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 55));
      active -= 1;
      return { status: 200 };
    },
  });
  const result = await Promise.all(Array.from({ length: 5 }, () => policy.fetchControlled(ENDPOINT)));
  assert.equal(result.length, 5);
  assert.ok(peak <= 2, `Pico inesperado: ${peak}`);
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i-1] >= 20, `Sem espaço entre requisições: ${starts}`);
  }
  assert.equal(policy.status("api.ebay.com").queued, 0);
});

test("HTTP 429 coloca a fonte em espera e rejeita a fila sem novas conexões", async () => {
  let requestCount = 0;
  const policy = createSourceRequestPolicy({
    minIntervalMs: 0,
    maxConcurrent: 1,
    fetchImpl: async () => {
      requestCount += 1;
      return {
        status: 429,
        headers: { get: (name) => name === "retry-after" ? "120" : null },
      };
    },
  });
  const results = await Promise.allSettled([
    policy.fetchControlled(ENDPOINT),
    policy.fetchControlled(ENDPOINT),
    policy.fetchControlled(ENDPOINT),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[0].value.status, 429);
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.status, 429);
  assert.equal(results[2].reason.rateLimited, true);
  assert.equal(requestCount, 1);
  assert.ok(policy.status("api.ebay.com").cooldownRemainingMs >= 119_000);
  await assert.rejects(() => policy.fetchControlled(ENDPOINT), /pausa automática/);
  assert.equal(requestCount, 1);
});

test("HTTP 403 e 503 suspendem novas chamadas por um período seguro", async () => {
  for (const [status, expected] of [[403, 300_000],[503,20_000]]) {
    let requestCount = 0;
    const policy = createSourceRequestPolicy({
      minIntervalMs: 0,
      fetchImpl: async () => {
        requestCount += 1;
        return { status, headers: { get: () => null } };
      },
    });
    assert.equal((await policy.fetchControlled(ENDPOINT)).status, status);
    assert.ok(policy.status("api.ebay.com").cooldownRemainingMs >= expected - 1000);
    await assert.rejects(() => policy.fetchControlled(ENDPOINT), (error) => error.status === status);
    assert.equal(requestCount, 1);
  }
});

test("Independência entre fontes: bloqueio eBay não suspende Mercado Livre", async () => {
  const calls = [];
  const policy = createSourceRequestPolicy({
    minIntervalMs: 0,
    fetchImpl: async (url) => {
      const host = new URL(url).hostname;
      calls.push(host);
      return { status: host === "api.ebay.com" ? 429 : 200, headers: { get: () => null } };
    },
  });
  await policy.fetchControlled(ENDPOINT);
  const ml = await policy.fetchControlled("https://api.mercadolibre.com/sites/MLB/search");
  assert.equal(ml.status, 200);
  assert.deepEqual(calls, ["api.ebay.com","api.mercadolibre.com"]);
});

test("Falhas de rede não deixam a fila travada", async () => {
  let attempts = 0;
  const policy = createSourceRequestPolicy({
    minIntervalMs: 0,
    maxConcurrent: 1,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Falha de rede");
      return { status: 200 };
    },
  });
  const result = await Promise.allSettled([
    policy.fetchControlled(ENDPOINT),
    policy.fetchControlled(ENDPOINT),
  ]);
  assert.equal(result[0].status, "rejected");
  assert.equal(result[1].status, "fulfilled");
  assert.equal(attempts, 2);
});
