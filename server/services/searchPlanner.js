const { parseTerms, normalizeText } = require("./radarCriteria");

function normalizeQuery(value) {
  return normalizeText(value)
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseLoose(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitBaseQueries(query) {
  return String(query || "")
    .split("|")
    .map((part) => titleCaseLoose(part))
    .filter(Boolean);
}

function extractModelTokens(text) {
  const raw = String(text || "")
    .replace(/[()\[\],;:/]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const stop = new Set([
    "SONY",
    "HANDYCAM",
    "CAMCORDER",
    "CAMERA",
    "FILMADORA",
    "DIGITAL",
    "VIDEO",
    "VINTAGE",
    "ORIGINAL",
    "NIGHTSHOT",
    "BLACK",
    "SILVER",
    "JAPAN",
  ]);

  return [
    ...new Set(
      raw
        .map((token) =>
          token
            .replace(/[^A-Za-z0-9-]/g, "")
            .toUpperCase(),
        )
        .filter(
          (token) =>
            token.length >= 4 &&
            token.length <= 18 &&
            /^[A-Z][A-Z0-9-]*\d[A-Z0-9-]*$/.test(token) &&
            !/^(?:HD|FULLHD|UHD|FHD)?\d+(?:GB|TB|MB|MP|X|MM|FPS|P|K)$/i.test(token) &&
            !stop.has(token),
        ),
    ),
  ].slice(0, 8);
}

function baseAnchor(query) {
  const words = String(query || "")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  return words.slice(0, 2).join(" ") || query;
}

function uniqueCandidates(candidates, max = 20) {
  const seen = new Set();
  const output = [];

  for (const candidate of candidates) {
    const queryText = titleCaseLoose(candidate.query_text);
    const normalized = normalizeQuery(queryText);

    if (!queryText || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    output.push({
      query_text: queryText,
      normalized_query: normalized,
      origin: candidate.origin || "generated",
      base_weight: Math.max(
        1,
        Math.min(100, Number(candidate.base_weight) || 70),
      ),
    });

    if (output.length >= max) break;
  }

  return output;
}

function buildGeneratedCandidates(
  radar,
  {
    catalogTitles = [],
    listingTitles = [],
  } = {},
) {
  const baseQueries = splitBaseQueries(radar.query);
  const priority = parseTerms(radar.priority_terms_json);
  const required = parseTerms(radar.required_terms_json);
  const anchor = baseAnchor(baseQueries[0] || radar.query);
  const candidates = [];

  for (const query of baseQueries) {
    candidates.push({
      query_text: query,
      origin: "base",
      base_weight: 100,
    });
  }

  for (const term of priority.slice(0, 8)) {
    if (
      !baseQueries.some((query) =>
        normalizeQuery(query).includes(normalizeQuery(term)),
      )
    ) {
      candidates.push({
        query_text: `${anchor} ${term}`,
        origin: "priority",
        base_weight: 86,
      });
    }
  }

  for (const term of required.slice(0, 4)) {
    candidates.push({
      query_text: `${anchor} ${term}`,
      origin: "required",
      base_weight: 82,
    });
  }

  const learnedModels = [
    ...catalogTitles,
    ...listingTitles,
  ].flatMap(extractModelTokens);

  for (const model of [...new Set(learnedModels)].slice(0, 8)) {
    candidates.push({
      query_text: `${anchor} ${model}`,
      origin: "learned_model",
      base_weight: 74,
    });
  }

  return uniqueCandidates(candidates, 20);
}

function performanceScore({
  runs = 0,
  resultsFound = 0,
  qualifiedFound = 0,
  rejectedFound = 0,
}) {
  const safeRuns = Math.max(0, Number(runs) || 0);
  const safeResults = Math.max(0, Number(resultsFound) || 0);
  const qualified = Math.max(0, Number(qualifiedFound) || 0);
  const rejected = Math.max(0, Number(rejectedFound) || 0);

  if (!safeRuns) return 50;

  const quality = safeResults
    ? Math.min(1, qualified / safeResults)
    : 0;
  const rejection = safeResults
    ? Math.min(1, rejected / safeResults)
    : 0;
  const yieldScore = Math.min(
    1,
    safeResults / Math.max(1, safeRuns * 8),
  );

  const raw = Math.max(
    0,
    Math.min(
      100,
      35 +
        quality * 45 +
        yieldScore * 20 -
        rejection * 25,
    ),
  );

  const confidence = Math.min(
    1,
    safeRuns / 4,
  );

  return Math.round(
    50 * (1 - confidence) +
      raw * confidence,
  );
}

function createSearchPlanner({ get, all, run }) {
  async function ensurePlan(radar) {
    const [catalogRows, listingRows] = await Promise.all([
      all(
        `SELECT title
         FROM catalog_discoveries
         WHERE radar_id = ?
         ORDER BY last_seen_at DESC
         LIMIT 30`,
        [radar.id],
      ),
      all(
        `SELECT title
         FROM listings
         WHERE radar_id = ?
           AND COALESCE(rule_rejected, 0) = 0
         ORDER BY COALESCE(rule_score, 0) DESC,
                  updated_at DESC
         LIMIT 40`,
        [radar.id],
      ),
    ]);

    const candidates = buildGeneratedCandidates(radar, {
      catalogTitles: catalogRows.map((row) => row.title),
      listingTitles: listingRows.map((row) => row.title),
    });

    for (const candidate of candidates) {
      await run(
        `INSERT INTO radar_search_queries (
          radar_id, query_text, normalized_query,
          origin, enabled, base_weight, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(radar_id, normalized_query)
        DO UPDATE SET
          query_text = excluded.query_text,
          origin = CASE
            WHEN radar_search_queries.origin = 'manual'
              THEN radar_search_queries.origin
            ELSE excluded.origin
          END,
          base_weight = CASE
            WHEN radar_search_queries.origin = 'manual'
              THEN radar_search_queries.base_weight
            ELSE excluded.base_weight
          END,
          updated_at = CURRENT_TIMESTAMP`,
        [
          radar.id,
          candidate.query_text,
          candidate.normalized_query,
          candidate.origin,
          candidate.base_weight,
        ],
      );
    }

    return listPlan(radar.id);
  }

  async function listPlan(radarId) {
    return all(
      `SELECT *,
         (base_weight * 0.45 + performance_score * 0.55)
           AS planner_score
       FROM radar_search_queries
       WHERE radar_id = ?
       ORDER BY enabled DESC,
                planner_score DESC,
                base_weight DESC,
                id ASC`,
      [radarId],
    );
  }

  async function selectedQueries(radar, limit = 8) {
    await ensurePlan(radar);

    const maxQueries = Math.max(
      1,
      Number(limit) || 8,
    );

    const candidates = await all(
      `SELECT *,
         (base_weight * 0.45 + performance_score * 0.55)
           AS planner_score
       FROM radar_search_queries
       WHERE radar_id = ?
         AND enabled = 1
       ORDER BY planner_score DESC,
                base_weight DESC,
                id ASC`,
      [radar.id],
    );

    if (!candidates.length) {
      return {
        rows: [],
        query: radar.query,
      };
    }

    const explorationSlots = Math.min(
      candidates.length,
      Math.max(
        1,
        Math.min(
          2,
          Math.floor(maxQueries / 3),
        ),
      ),
    );

    const untested = candidates
      .filter((row) => Number(row.runs || 0) === 0)
      .sort(
        (a, b) =>
          Number(b.base_weight || 0) -
            Number(a.base_weight || 0) ||
          Number(a.id || 0) -
            Number(b.id || 0),
      )
      .slice(0, explorationSlots);

    const selectedIds = new Set(
      untested.map((row) => row.id),
    );

    const exploitation = candidates
      .filter((row) => !selectedIds.has(row.id))
      .slice(
        0,
        Math.max(0, maxQueries - untested.length),
      );

    const rows = [
      ...exploitation,
      ...untested,
    ].slice(0, maxQueries);

    return {
      rows,
      exploration_count: untested.length,
      query: rows
        .map((row) => row.query_text)
        .join(" | "),
    };
  }

  async function addManualQuery(radarId, queryText) {
    const normalized = normalizeQuery(queryText);
    if (!normalized) {
      const error = new Error("Busca vazia.");
      error.status = 400;
      throw error;
    }

    await run(
      `INSERT INTO radar_search_queries (
        radar_id, query_text, normalized_query,
        origin, enabled, base_weight,
        performance_score, updated_at
      ) VALUES (?, ?, ?, 'manual', 1, 100, 55, CURRENT_TIMESTAMP)
      ON CONFLICT(radar_id, normalized_query)
      DO UPDATE SET
        query_text = excluded.query_text,
        origin = 'manual',
        enabled = 1,
        base_weight = 100,
        updated_at = CURRENT_TIMESTAMP`,
      [radarId, titleCaseLoose(queryText), normalized],
    );

    return get(
      `SELECT *
       FROM radar_search_queries
       WHERE radar_id = ? AND normalized_query = ?`,
      [radarId, normalized],
    );
  }

  async function setQueryState(
    radarId,
    queryId,
    {
      enabled,
      baseWeight,
    } = {},
  ) {
    const row = await get(
      `SELECT *
       FROM radar_search_queries
       WHERE id = ? AND radar_id = ?`,
      [queryId, radarId],
    );

    if (!row) {
      const error = new Error("Query do planner não encontrada.");
      error.status = 404;
      throw error;
    }

    const nextEnabled =
      enabled === undefined
        ? Number(row.enabled || 0)
        : enabled
          ? 1
          : 0;
    const nextWeight =
      baseWeight === undefined
        ? Number(row.base_weight || 70)
        : Math.max(
            1,
            Math.min(100, Number(baseWeight) || 70),
          );

    await run(
      `UPDATE radar_search_queries
       SET enabled = ?,
           base_weight = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND radar_id = ?`,
      [
        nextEnabled,
        nextWeight,
        queryId,
        radarId,
      ],
    );

    return get(
      `SELECT *
       FROM radar_search_queries
       WHERE id = ? AND radar_id = ?`,
      [queryId, radarId],
    );
  }

  async function recordPerformance(
    radarId,
    selectedRows,
    evaluatedItems,
  ) {
    const normalizedRows = new Map(
      (selectedRows || []).map((row) => [
        normalizeQuery(row.query_text),
        row,
      ]),
    );

    const buckets = new Map();

    for (const row of selectedRows || []) {
      buckets.set(row.id, {
        row,
        found: 0,
        qualified: 0,
        rejected: 0,
      });
    }

    for (const item of evaluatedItems || []) {
      const searchQuery = normalizeQuery(
        item.search_query || "",
      );

      if (!searchQuery) continue;

      const planRow =
        normalizedRows.get(searchQuery);

      if (!planRow) continue;

      const bucket = buckets.get(planRow.id);
      if (!bucket) continue;

      bucket.found += 1;

      if (item.rule_rejected) {
        bucket.rejected += 1;
        continue;
      }

      const ranking = Number(
        item.ranking_score ??
          item.grail_score ??
          item.hybrid_score ??
          0,
      );

      if (
        item.rule_tier === "alta" ||
        ranking >= 70
      ) {
        bucket.qualified += 1;
      }
    }

    for (const bucket of buckets.values()) {
      const previousRuns =
        Number(bucket.row.runs || 0);
      const previousFound =
        Number(bucket.row.results_found || 0);
      const previousQualified =
        Number(bucket.row.qualified_found || 0);
      const previousRejected =
        Number(bucket.row.rejected_found || 0);

      const nextRuns = previousRuns + 1;
      const nextFound =
        previousFound + bucket.found;
      const nextQualified =
        previousQualified + bucket.qualified;
      const nextRejected =
        previousRejected + bucket.rejected;

      const nextPerformance =
        performanceScore({
          runs: nextRuns,
          resultsFound: nextFound,
          qualifiedFound: nextQualified,
          rejectedFound: nextRejected,
        });

      await run(
        `UPDATE radar_search_queries
         SET runs = ?,
             results_found = ?,
             qualified_found = ?,
             rejected_found = ?,
             last_results_found = ?,
             last_qualified_found = ?,
             performance_score = ?,
             last_run_at = CURRENT_TIMESTAMP,
             last_result_at = CASE
               WHEN ? > 0 THEN CURRENT_TIMESTAMP
               ELSE last_result_at
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND radar_id = ?`,
        [
          nextRuns,
          nextFound,
          nextQualified,
          nextRejected,
          bucket.found,
          bucket.qualified,
          nextPerformance,
          bucket.found,
          bucket.row.id,
          radarId,
        ],
      );
    }
  }

  async function regeneratePlan(radar) {
    await run(
      `DELETE FROM radar_search_queries
       WHERE radar_id = ?
         AND origin <> 'manual'`,
      [radar.id],
    );

    return ensurePlan(radar);
  }

  return {
    ensurePlan,
    listPlan,
    selectedQueries,
    addManualQuery,
    setQueryState,
    recordPerformance,
    regeneratePlan,
  };
}

module.exports = {
  normalizeQuery,
  extractModelTokens,
  buildGeneratedCandidates,
  performanceScore,
  createSearchPlanner,
};
