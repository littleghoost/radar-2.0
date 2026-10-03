function normalize(values = []) {
  const vector = Array.from(values, Number);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return vector;
  return vector.map((value) => value / norm);
}

function cosine(left = [], right = []) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    aa += left[i] * left[i];
    bb += right[i] * right[i];
  }
  if (!aa || !bb) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(aa * bb)));
}

function centroid(vectors = []) {
  const valid = vectors.filter((vector) => Array.isArray(vector) && vector.length);
  if (!valid.length) return null;
  const size = valid[0].length;
  const sum = new Array(size).fill(0);
  let count = 0;
  for (const vector of valid) {
    if (vector.length !== size) continue;
    for (let i = 0; i < size; i += 1) sum[i] += Number(vector[i]) || 0;
    count += 1;
  }
  if (!count) return null;
  return normalize(sum.map((value) => value / count));
}

function buildPreferenceProfile(rows = [], category = 'geral') {
  const positives = [];
  const negatives = [];
  for (const row of rows) {
    if (!row.image_embedding_json) continue;
    let embedding;
    try {
      embedding = JSON.parse(row.image_embedding_json);
    } catch {
      continue;
    }
    if (!Array.isArray(embedding) || !embedding.length) continue;
    if (row.status === 'interessante') positives.push(embedding);
    if (row.status === 'descartado') negatives.push(embedding);
  }

  return {
    category,
    positive_count: positives.length,
    negative_count: negatives.length,
    total_feedback: positives.length + negatives.length,
    positive_centroid: centroid(positives),
    negative_centroid: centroid(negatives),
  };
}

function preferenceScore(embedding, profile) {
  if (!Array.isArray(embedding) || !embedding.length || !profile) return null;
  const hasPositive = Array.isArray(profile.positive_centroid);
  const hasNegative = Array.isArray(profile.negative_centroid);
  if (!hasPositive && !hasNegative) return null;

  const positive = hasPositive ? cosine(embedding, profile.positive_centroid) : null;
  const negative = hasNegative ? cosine(embedding, profile.negative_centroid) : null;

  let score;
  if (hasPositive && hasNegative) {
    score = positive * 0.72 + (1 - negative) * 0.28;
  } else if (hasPositive) {
    score = positive;
  } else {
    score = 1 - negative;
  }

  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

function grailScore(hybridScore, learnedScore, feedbackCount = 0) {
  const hybrid = Number(hybridScore);
  if (!Number.isFinite(hybrid)) return learnedScore ?? null;
  if (learnedScore === null || learnedScore === undefined) return Math.round(hybrid);

  const confidence = Math.min(1, Math.max(0, Number(feedbackCount) / 8));
  const learnedWeight = 0.15 + confidence * 0.3;
  return Math.round(hybrid * (1 - learnedWeight) + Number(learnedScore) * learnedWeight);
}

module.exports = {
  buildPreferenceProfile,
  preferenceScore,
  grailScore,
};
