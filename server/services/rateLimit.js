"use strict";

// Limiter em memória, por IP. Suficiente para uma instância única (Fly com 1
// máquina). Se um dia houver múltiplas instâncias, trocar por Redis.
function clientIp(req) {
  return String(
    req.headers["fly-client-ip"] ||
      req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      "unknown",
  )
    .split(",")[0]
    .trim();
}

function createMemoryRateLimiter({
  windowMs = 60_000,
  limit = 30,
  now = () => Date.now(),
  maxBuckets = 500,
} = {}) {
  const buckets = new Map();

  function prune(currentTime) {
    for (const [key, value] of buckets) {
      if (currentTime - value.startedAt >= windowMs) {
        buckets.delete(key);
      }
    }
  }

  function rateLimit(req, res, next) {
    const currentTime = now();
    const key = clientIp(req);
    const bucket = buckets.get(key);

    if (!bucket || currentTime - bucket.startedAt >= windowMs) {
      buckets.set(key, { startedAt: currentTime, count: 1 });
      if (buckets.size > maxBuckets) prune(currentTime);
      return next();
    }

    bucket.count += 1;

    if (bucket.count > limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((bucket.startedAt + windowMs - currentTime) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Muitas tentativas. Aguarde um pouco.",
      });
    }

    return next();
  }

  rateLimit.reset = () => buckets.clear();

  return rateLimit;
}

module.exports = { createMemoryRateLimiter, clientIp };
