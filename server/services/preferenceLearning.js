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

const TITLE_STOP = new Set([
  'calca','jeans','camisa','camiseta','roupa','usado','usada','novo','nova',
  'vintage','original','rare','raro','size','sz','black','preto','preta',
  'sony','handycam','filmadora','camera','digital','the','and','for','com',
  'para','de','da','do','em','brasil','tamanho','item','nice','y2k',
]);
function titleTokens(title) {
  return [...new Set(String(title||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,' ').split(/\s+/)
    .filter(word=>word.length>=3 && !TITLE_STOP.has(word)))];
}
function buildPreferenceProfile(rows = [], category = 'geral') {
  const positives = [], negatives = [];
  const positiveTerms = {}, negativeTerms = {};
  let labeledPositive = 0, labeledNegative = 0;
  for (const row of rows) {
    if (!['interessante','descartado'].includes(row.status)) continue;
    const isPositive = row.status === 'interessante';
    if (isPositive) labeledPositive++; else labeledNegative++;
    const counts = isPositive ? positiveTerms : negativeTerms;
    for (const word of titleTokens(row.title)) counts[word]=(counts[word]||0)+1;
    let embedding;
    try {embedding=JSON.parse(row.image_embedding_json);} catch {continue;}
    if (!Array.isArray(embedding) || !embedding.length) continue;
    if (isPositive) positives.push(embedding); else negatives.push(embedding);
  }
  return {
    category,
    positive_count:positives.length,negative_count:negatives.length,
    labeled_positive:labeledPositive,labeled_negative:labeledNegative,
    total_feedback:labeledPositive+labeledNegative,
    positive_terms:positiveTerms,negative_terms:negativeTerms,
    positive_centroid:centroid(positives),negative_centroid:centroid(negatives),
  };
}
function textPreferenceScore(title, profile) {
  const words = titleTokens(title);
  if (!words.length || !profile?.total_feedback) return null;
  const pos = words.reduce((v,w)=>v+(profile.positive_terms?.[w]||0),0);
  const neg = words.reduce((v,w)=>v+(profile.negative_terms?.[w]||0),0);
  if (!pos && !neg) return null;
  // Bayesian smoothing avoids extreme scores from a single token.
  return Math.max(5,Math.min(95,Math.round(50 + 45*(pos-neg)/(pos+neg+2))));
}
function preferenceScore(embedding, profile, title = '') {
  if (!profile) return null;
  const hasPositive = Array.isArray(profile.positive_centroid);
  const hasNegative = Array.isArray(profile.negative_centroid);
  if (Array.isArray(embedding) && embedding.length && (hasPositive || hasNegative)) {
    const positive = hasPositive ? cosine(embedding, profile.positive_centroid) : null;
    const negative = hasNegative ? cosine(embedding, profile.negative_centroid) : null;
    const score=hasPositive && hasNegative
      ? positive*0.72 + (1-negative)*0.28
      : hasPositive ? positive : 1-negative;
    return Math.max(0,Math.min(100,Math.round(score*100)));
  }
  // Sem embedding, o feedback ainda ensina sinais no título. Isso NÃO é
  // reconhecimento visual: a interface explica essa limitação ao usuário.
  return textPreferenceScore(title,profile);
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
