const path = require('path');

const MODEL_ID = process.env.SEMANTIC_MODEL || 'Xenova/clip-vit-base-patch32';
let extractorPromise = null;
let lastError = null;
let ready = false;

function isEnabled() {
  return process.env.SEMANTIC_VISION_ENABLED === '1';
}

async function getExtractor() {
  if (!isEnabled()) {
    throw new Error('semantic_vision_disabled');
  }

  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        const { pipeline, env } = require('@huggingface/transformers');
        const defaultCache = path.join(
          process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, '..', '..', 'data'),
          'models',
        );
        env.cacheDir = process.env.SEMANTIC_CACHE_DIR || defaultCache;
        env.allowRemoteModels = true;
        env.allowLocalModels = true;

        const extractor = await pipeline('image-feature-extraction', MODEL_ID, {
          dtype: process.env.SEMANTIC_DTYPE || 'q8',
        });
        ready = true;
        lastError = null;
        return extractor;
      } catch (error) {
        lastError = error?.message || String(error);
        extractorPromise = null;
        throw error;
      }
    })();
  }

  return extractorPromise;
}

function normalize(vector) {
  const values = Array.from(vector, Number);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return values;
  return values.map((value) => value / norm);
}

async function embedImage(buffer) {
  const extractor = await getExtractor();
  const blob = new Blob([buffer]);
  const { RawImage } = require('@huggingface/transformers');
  const image = await RawImage.read(blob);
  const output = await extractor(image);
  const vector = normalize(output.data || []);
  if (!vector.length) throw new Error('embedding vazio');
  return vector.map((value) => Number(value.toFixed(7)));
}

function cosineSimilarity(left = [], right = []) {
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
  const cosine = dot / Math.sqrt(aa * bb);
  return Math.max(0, Math.min(1, cosine));
}

function status() {
  return {
    enabled: isEnabled(),
    model: MODEL_ID,
    ready,
    loading: Boolean(extractorPromise) && !ready,
    last_error: lastError,
  };
}

module.exports = {
  MODEL_ID,
  embedImage,
  cosineSimilarity,
  status,
  isEnabled,
};
