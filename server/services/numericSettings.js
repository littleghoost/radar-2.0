"use strict";

// Zero is an intentional slider value; missing/invalid input uses the default.
function boundedNumber(value, fallback, min = 0, max = 100) {
  const parsed = value === null || value === undefined || value === ""
    ? fallback
    : Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

module.exports = {boundedNumber};
