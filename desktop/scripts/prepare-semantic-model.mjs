import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline, env } from "@huggingface/transformers";

const here = dirname(fileURLToPath(import.meta.url));
const targetCache = resolve(here, "../src-tauri/resources/models");
const model = process.env.SEMANTIC_MODEL || "Xenova/clip-vit-base-patch32";
const modelRel = join(...model.split("/"));

function modelReady(root) {
  if (!root) return false;
  const modelDir = join(root, modelRel);
  return [
    join(modelDir, "config.json"),
    join(modelDir, "preprocessor_config.json"),
    join(modelDir, "onnx", "vision_model_quantized.onnx"),
  ].every(existsSync);
}

function copyCachedModel(sourceRoot) {
  if (!modelReady(sourceRoot)) return false;
  const source = join(sourceRoot, modelRel);
  const destination = join(targetCache, modelRel);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
  console.log(`Modelo reaproveitado do cache local: ${sourceRoot}`);
  return true;
}

mkdirSync(targetCache, { recursive: true });

if (!modelReady(targetCache)) {
  const candidates = [
    process.env.RADAR_SEMANTIC_MODEL_CACHE,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Radar2SemanticModelCache") : null,
    process.env.TEMP ? join(process.env.TEMP, "radar-semantic-sidecar2-models") : null,
    process.env.APPDATA ? join(process.env.APPDATA, "com.littleghoost.radar2", "models") : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (copyCachedModel(candidate)) break;
  }
}

if (!modelReady(targetCache)) {
  env.cacheDir = targetCache;
  env.allowRemoteModels = true;
  env.allowLocalModels = true;

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`Baixando modelo semântico ${model} (tentativa ${attempt}/3)...`);
      const extractor = await pipeline("image-feature-extraction", model, {
        dtype: process.env.SEMANTIC_DTYPE || "q8",
      });
      await extractor.dispose?.();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      console.warn(`Falha ao baixar o modelo: ${error?.cause?.message || error?.message || error}`);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
    }
  }

  if (lastError || !modelReady(targetCache)) {
    throw new Error(
      "Não foi possível preparar o modelo semântico. Tente novamente com internet ou defina RADAR_SEMANTIC_MODEL_CACHE para um cache já baixado.",
      { cause: lastError || undefined },
    );
  }
}

console.log(`Modelo semântico pronto para empacotamento em ${targetCache}.`);
