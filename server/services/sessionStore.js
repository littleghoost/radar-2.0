"use strict";
const crypto = require("crypto");

// Sessões opacas: o cookie recebe um token aleatório e o banco guarda apenas o
// HMAC do token. Assim um vazamento de banco não permite reaproveitar sessões.
function createSessionStore({
  get,
  run,
  secret = "",
  ttlDays = 30,
  now = () => new Date(),
} = {}) {
  if (typeof get !== "function" || typeof run !== "function") {
    throw new Error("createSessionStore precisa de get e run.");
  }

  function hashToken(token) {
    const value = String(token || "");
    if (!value) return "";
    return secret
      ? crypto.createHmac("sha256", secret).update(value).digest("hex")
      : crypto.createHash("sha256").update(value).digest("hex");
  }

  async function purgeExpired() {
    await run(
      `DELETE FROM sessions
       WHERE expires_at <= CURRENT_TIMESTAMP OR revoked_at IS NOT NULL`,
    );
  }

  async function createSession({ ip = "", userAgent = "" } = {}) {
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      now().getTime() + ttlDays * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    await run(
      `INSERT INTO sessions (token_hash, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?)`,
      [
        hashToken(token),
        expiresAt,
        String(ip || "").slice(0, 64),
        String(userAgent || "").slice(0, 200),
      ],
    );

    return token;
  }

  async function isValidSession(token) {
    if (typeof token !== "string" || token.length < 20 || token.length > 200) {
      return false;
    }

    const row = await get(
      `SELECT id FROM sessions
       WHERE token_hash = ?
         AND revoked_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
      [hashToken(token)],
    );

    return Boolean(row);
  }

  async function touchSession(token) {
    if (typeof token !== "string" || !token) return false;
    await run(
      `UPDATE sessions
       SET last_seen_at = CURRENT_TIMESTAMP
       WHERE token_hash = ? AND revoked_at IS NULL`,
      [hashToken(token)],
    );
    return true;
  }

  async function revokeSession(token) {
    if (typeof token !== "string" || !token) return false;
    const result = await run(
      `UPDATE sessions
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE token_hash = ? AND revoked_at IS NULL`,
      [hashToken(token)],
    );
    return Boolean(result?.changes);
  }

  async function revokeAllSessions() {
    const result = await run(
      `UPDATE sessions
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE revoked_at IS NULL`,
    );
    return result?.changes || 0;
  }

  return {
    hashToken,
    createSession,
    isValidSession,
    touchSession,
    revokeSession,
    revokeAllSessions,
    purgeExpired,
  };
}

module.exports = { createSessionStore };
