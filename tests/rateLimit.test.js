"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryRateLimiter } = require("../server/services/rateLimit");

function fakeRequest(ip) {
  return {
    headers: { "fly-client-ip": ip },
    socket: { remoteAddress: ip },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function call(limiter, ip) {
  const req = fakeRequest(ip);
  const res = fakeResponse();
  let passed = false;
  limiter(req, res, () => {
    passed = true;
  });
  return { passed, res };
}

test("Limite de tentativas bloqueia com 429 e Retry-After", () => {
  let clock = 1_000_000;
  const limiter = createMemoryRateLimiter({
    windowMs: 60_000,
    limit: 3,
    now: () => clock,
  });

  for (let i = 0; i < 3; i += 1) {
    assert.equal(call(limiter, "198.51.100.7").passed, true);
  }

  const blocked = call(limiter, "198.51.100.7");
  assert.equal(blocked.passed, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.ok(Number(blocked.res.headers["retry-after"]) >= 1);

  clock += 60_001;
  assert.equal(call(limiter, "198.51.100.7").passed, true);
});

test("Cada IP tem sua própria cota", () => {
  const limiter = createMemoryRateLimiter({ windowMs: 60_000, limit: 1 });

  assert.equal(call(limiter, "198.51.100.1").passed, true);
  assert.equal(call(limiter, "198.51.100.1").passed, false);
  assert.equal(call(limiter, "198.51.100.2").passed, true);
});

test("x-forwarded-for com vários IPs usa o primeiro", () => {
  const limiter = createMemoryRateLimiter({ windowMs: 60_000, limit: 1 });
  const req = {
    headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    socket: { remoteAddress: "10.0.0.1" },
  };

  let passed = 0;
  limiter(req, fakeResponse(), () => {
    passed += 1;
  });
  limiter(req, fakeResponse(), () => {
    passed += 1;
  });

  assert.equal(passed, 1);
});
