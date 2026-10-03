const fs = require('fs/promises');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function decodeImage(buffer) {
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isJpeg = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
  if (isPng) {
    const image = PNG.sync.read(buffer);
    return { width: image.width, height: image.height, data: image.data };
  }
  if (isJpeg) {
    const image = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
    return { width: image.width, height: image.height, data: image.data };
  }
  throw new Error('Formato não suportado ainda. Use JPEG ou PNG.');
}

function pixel(image, x, y) {
  const safeX = Math.max(0, Math.min(image.width - 1, x));
  const safeY = Math.max(0, Math.min(image.height - 1, y));
  const index = (safeY * image.width + safeX) * 4;
  return {
    r: image.data[index] || 0,
    g: image.data[index + 1] || 0,
    b: image.data[index + 2] || 0,
    a: image.data[index + 3] === undefined ? 255 : image.data[index + 3],
  };
}

function samplePixel(image, x, y, targetW, targetH) {
  const sourceX = Math.min(image.width - 1, Math.floor(((x + 0.5) / targetW) * image.width));
  const sourceY = Math.min(image.height - 1, Math.floor(((y + 0.5) / targetH) * image.height));
  return pixel(image, sourceX, sourceY);
}

function luma({ r, g, b }) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

async function extractVisualFeatures(buffer) {
  const image = decodeImage(buffer);
  const width = image.width;
  const height = image.height;
  const aspectRatio = width && height ? width / height : 1;

  let hash = '';
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = samplePixel(image, x, y, 9, 8);
      const right = samplePixel(image, x + 1, y, 9, 8);
      hash += luma(left) > luma(right) ? '1' : '0';
    }
  }

  const histogram = new Array(64).fill(0);
  let rTotal = 0;
  let gTotal = 0;
  let bTotal = 0;
  let count = 0;

  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const { r, g, b, a } = samplePixel(image, x, y, 32, 32);
      if (a < 32) continue;
      const ri = Math.min(3, Math.floor(r / 64));
      const gi = Math.min(3, Math.floor(g / 64));
      const bi = Math.min(3, Math.floor(b / 64));
      histogram[ri * 16 + gi * 4 + bi] += 1;
      rTotal += r;
      gTotal += g;
      bTotal += b;
      count += 1;
    }
  }

  const safeCount = Math.max(1, count);
  return {
    version: 1,
    width,
    height,
    aspect_ratio: Number(aspectRatio.toFixed(4)),
    dhash: hash,
    histogram: histogram.map((value) => Number((value / safeCount).toFixed(6))),
    average_rgb: [
      Math.round(rTotal / safeCount),
      Math.round(gTotal / safeCount),
      Math.round(bTotal / safeCount),
    ],
  };
}

async function extractVisualFeaturesFromFile(filePath) {
  return extractVisualFeatures(await fs.readFile(filePath));
}

async function downloadImage(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Radar2/0.1 visual-indexer' },
    });
    if (!response.ok) throw new Error(`imagem HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 10 * 1024 * 1024) throw new Error('imagem excede 10 MB');
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

function hammingSimilarity(a = '', b = '') {
  if (!a || !b || a.length !== b.length) return 0;
  let different = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) different += 1;
  return 1 - different / a.length;
}

function cosineSimilarity(a = [], b = []) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (!aa || !bb) return 0;
  return clamp01(dot / Math.sqrt(aa * bb));
}

function aspectSimilarity(a, b) {
  const left = Math.max(0.01, Number(a) || 1);
  const right = Math.max(0.01, Number(b) || 1);
  return clamp01(Math.min(left, right) / Math.max(left, right));
}

function visualSimilarity(reference, candidate) {
  if (!reference || !candidate) return 0;
  const hash = hammingSimilarity(reference.dhash, candidate.dhash);
  const hist = cosineSimilarity(reference.histogram, candidate.histogram);
  const aspect = aspectSimilarity(reference.aspect_ratio, candidate.aspect_ratio);
  return clamp01(hash * 0.48 + hist * 0.42 + aspect * 0.1);
}

function tokenize(text = '') {
  return new Set(String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((token) => token.length >= 2));
}

function textSimilarity(query, title) {
  const wanted = tokenize(query);
  const have = tokenize(title);
  if (!wanted.size) return 0.5;
  let hits = 0;
  for (const token of wanted) if (have.has(token)) hits += 1;
  return clamp01(hits / wanted.size);
}

function priceScore(price, maxPrice, currency = 'BRL') {
  if (price === null || price === undefined || !maxPrice || currency !== 'BRL') return 0.5;
  const ratio = Number(price) / Number(maxPrice);
  if (!Number.isFinite(ratio)) return 0.5;
  if (ratio <= 0.5) return 1;
  if (ratio <= 1) return 1 - (ratio - 0.5) * 0.8;
  return Math.max(0, 0.6 - (ratio - 1));
}

function hybridScore({ visual = null, query, title, price, maxPrice, currency, visualWeight = 70 }) {
  const visualEnabled = visual !== null && Number.isFinite(Number(visual));
  const text = textSimilarity(query, title);
  const priceComponent = priceScore(price, maxPrice, currency);
  if (!visualEnabled) return Math.round((text * 0.75 + priceComponent * 0.25) * 100);
  const vw = clamp01(Number(visualWeight) / 100);
  const remaining = 1 - vw;
  return Math.round((clamp01(visual) * vw + text * remaining * 0.7 + priceComponent * remaining * 0.3) * 100);
}

module.exports = {
  extractVisualFeatures,
  extractVisualFeaturesFromFile,
  downloadImage,
  visualSimilarity,
  hybridScore,
};
