"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const sqlite3 = require("sqlite3");
const { PNG } = require("pngjs");

let directory, baseUrl, imageUrl, imageServer, child;
let output = "";

function png(red, green, blue) {
  const image = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data.set([red, green, blue, 255], i);
  }
  return PNG.sync.write(image);
}

async function api(route, method = "GET", body, expected = 200) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
  return result;
}

async function start() {
  // Ask the OS for a free port instead of depending on the developer's server.
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/app.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(directory, "radar.db"),
      IMAGE_DIR: path.join(directory, "images"),
      VISUAL_REFERENCE_DIR: path.join(directory, "references"),
      RADAR_DESKTOP: "0",
      RADAR_PASSWORD: "",
      SESSION_SECRET: "",
      SEMANTIC_VISION_ENABLED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  for (let i = 0; i < 100; i += 1) {
    assert.equal(child.exitCode, null, output);
    try {
      const health = await api("/api/health");
      assert.equal(health.database, "ok");
      await api("/api/radars");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Servidor de teste não iniciou: ${output}`);
}

async function stop() {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
}

async function radar(overrides = {}) {
  return api("/api/radars", "POST", {
    name: "Radar de teste",
    query: "camisa vintage",
    category: "roupas",
    max_price: 200,
    ...overrides,
  }, 201);
}

function item(key, overrides = {}) {
  return {
    title: "Camisa vintage",
    platform: "Marketplace de teste",
    url: `https://marketplace.example/item/${key}`,
    image_url: imageUrl + "/red.png",
    current_price: 80,
    currency: "BRL",
    ...overrides,
  };
}

async function importItems(radarId, items, overrides = {}) {
  return api("/api/import/assisted", "POST", {
    radar_id: radarId,
    source_url: "https://marketplace.example/busca",
    items,
    ...overrides,
  });
}

async function listings(radarId) {
  return api(`/api/listings?radar_id=${radarId}`);
}

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "radar-assisted-test-"));
  imageServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(req.url === "/blue.png" ? png(0, 0, 255) : png(255, 0, 0));
  });
  await new Promise((resolve) => imageServer.listen(0, "127.0.0.1", resolve));
  imageUrl = `http://127.0.0.1:${imageServer.address().port}`;
  await start();
  // Keep this suite independent of exchange-rate providers and credentials.
  await api("/api/international-cost/settings", "PATCH", { enabled: false });
});

after(async () => {
  await stop();
  if (imageServer) await new Promise((resolve) => imageServer.close(resolve));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test("Importação preserva título, preço, imagem e link, com scores e histórico", async () => {
  const target = await radar();
  const original = item("fields");
  const result = await importItems(target.id, [original]);
  assert.equal(result.imported, 1);
  assert.equal(result.failed, 0);
  const [listing] = await listings(target.id);
  for (const key of ["title", "platform", "url", "image_url", "current_price", "currency"]) {
    assert.equal(listing[key], original[key], key);
  }
  assert.equal(listing.status, "novo");
  assert.equal(listing.hybrid_score, 100);
  assert.equal(listing.grail_score, 100);
  assert.equal(listing.ranking_score, 100);
  assert.equal(listing.preference_score, null);
  assert.equal(listing.semantic_score, null);
  assert.equal(listing.availability_status, "available");
  assert.deepEqual((await api(`/api/listings/${listing.id}/prices`)).map((row) => row.price), [80]);
});

test("Duplicatas no lote e em outra captura não criam anúncios ou preços repetidos", async () => {
  const target = await radar();
  const original = item("duplicate");
  const first = await importItems(target.id, [original, original]);
  assert.equal(first.imported, 1);
  assert.equal(first.duplicates, 1);
  const second = await importItems(target.id, [original]);
  assert.equal(second.duplicates, 1);
  assert.equal(second.imported, 0);
  assert.equal(second.updated, 0);
  const rows = await listings(target.id);
  assert.equal(rows.length, 1);
  assert.equal((await api(`/api/listings/${rows[0].id}/prices`)).length, 1);
});

test("Identidade do marketplace deduplica links diferentes do mesmo anúncio", async () => {
  const target = await radar();
  const original = item("identity", { platform: "eBay", url: "https://www.ebay.com/itm/123456789012" });
  await importItems(target.id, [original]);
  const result = await importItems(target.id, [{ ...original, url: original.url + "?campaign=bridge" }]);
  assert.equal(result.duplicates, 1);
  assert.equal((await listings(target.id)).length, 1);
});

test("Reimportação atualiza scores e regras sem perder estado, notas ou histórico", async () => {
  const target = await radar({ required_terms: ["vintage"], exclude_terms: ["defeito"] });
  const original = item("refresh");
  const first = await importItems(target.id, [original]);
  const id = first.listings[0].id;
  await api(`/api/listings/${id}`, "PATCH", { status: "interessante", notes: "Quero acompanhar" });
  const result = await importItems(target.id, [{
    ...original, title: "Camisa vintage com defeito", current_price: 500,
    image_url: imageUrl + "/blue.png",
  }]);
  assert.equal(result.updated, 1);
  assert.equal(result.imported, 0);
  const [updated] = await listings(target.id);
  assert.equal(updated.status, "interessante");
  assert.equal(updated.notes, "Quero acompanhar");
  assert.equal(updated.title, "Camisa vintage com defeito");
  assert.equal(updated.image_url, imageUrl + "/blue.png");
  assert.equal(updated.current_price, 500);
  assert.equal(updated.rule_rejected, true);
  assert.equal(updated.ranking_score, 0);
  assert.ok(updated.hybrid_score < first.listings[0].hybrid_score);
  assert.equal(result.listings[0].ranking_score, 0);
  assert.deepEqual((await api(`/api/listings/${id}/prices`)).map((row) => row.price).sort((a, b) => a - b), [80, 500]);
  const cheaper = await importItems(target.id, [{ ...original, current_price: 60 }]);
  assert.equal(cheaper.price_drops, 1);
  const [restored] = await listings(target.id);
  assert.equal(restored.rule_rejected, false);
  assert.ok(restored.ranking_score > 0);
});

test("Regras priorizam termos e identificam exclusões e ausência de termos obrigatórios", async () => {
  const target = await radar({ required_terms: ["vintage"], priority_terms: ["linho"], exclude_terms: ["defeito"] });
  const result = await importItems(target.id, [
    item("priority", { title: "Camisa vintage linho" }),
    item("normal"),
    item("excluded", { title: "Camisa vintage defeito" }),
    item("required", { title: "Camisa moderna" }),
  ]);
  assert.equal(result.imported, 4);
  const rows = await listings(target.id);
  assert.equal(rows[0].title, "Camisa vintage linho");
  assert.ok(rows[0].ranking_score > rows[1].ranking_score);
  for (const row of rows.slice(2)) {
    assert.equal(row.rule_rejected, true);
    assert.equal(row.ranking_score, 0);
    assert.equal(row.inbox_tier, "ruido");
  }
});

test("Imagem de referência gera score perceptual e é recalculada na reimportação", async () => {
  const target = await radar();
  const upload = await fetch(baseUrl + `/api/radars/${target.id}/reference-image`, {
    method: "PUT", headers: { "content-type": "image/png" }, body: png(255, 0, 0),
  });
  assert.equal(upload.status, 200, await upload.text());
  const original = item("visual");
  const first = await importItems(target.id, [original]);
  assert.equal(first.listings[0].visual_score, 100);
  const updated = await importItems(target.id, [{ ...original, image_url: imageUrl + "/blue.png" }]);
  assert.equal(updated.updated, 1);
  assert.ok(updated.listings[0].visual_score < 100);
  assert.ok(updated.listings[0].hybrid_score < first.listings[0].hybrid_score);
});

test("API rejeita itens sem título ou URL HTTP/HTTPS e limita o lote a cem", async () => {
  const target = await radar();
  await api("/api/import/assisted", "POST", { items: [] }, 400);
  await api("/api/import/assisted", "POST", { radar_id: -1, items: [item("missing-radar")] }, 404);
  const invalid = await importItems(target.id, [null, {}, item("invalid", { url: "javascript:alert(1)" }), item("empty", { title: " " })]);
  assert.equal(invalid.invalid, 4);
  assert.equal(invalid.imported, 0);
  const limited = await importItems(target.id, Array.from({ length: 101 }, (_, i) => item(`limit-${i}`)));
  assert.equal(limited.imported, 100);
  assert.equal((await listings(target.id)).length, 100);
});

test("Estados interessante/descartado persistem e os filtros do feed os respeitam", async () => {
  const target = await radar();
  const result = await importItems(target.id, [item("favorite"), item("discard")]);
  const [favorite, discarded] = result.listings;
  await api(`/api/listings/${favorite.id}`, "PATCH", { status: "interessante" });
  await api(`/api/listings/${discarded.id}`, "PATCH", { status: "descartado" });
  const favorites = await api(`/api/listings?radar_id=${target.id}&status=interessante&search=Camisa`);
  assert.deepEqual(favorites.map((row) => row.id), [favorite.id]);
  await stop();
  await start();
  const rows = await listings(target.id);
  assert.equal(rows.find((row) => row.id === favorite.id).status, "interessante");
  assert.equal(rows.find((row) => row.id === discarded.id).status, "descartado");
  assert.equal((await api(`/api/listings?radar_id=${target.id}&search=inexistente`)).length, 0);
});

test("Estado inválido não pode tirar um anúncio dos filtros do feed", async () => {
  const target = await radar();
  const result = await importItems(target.id, [item("invalid-status")]);
  await api(`/api/listings/${result.listings[0].id}`, "PATCH", { status: "inexistente" }, 400);
  assert.equal((await listings(target.id))[0].status, "novo");
});

test("Feedback com embeddings existentes atualiza Grail e ordenação, e sua remoção desfaz o aprendizado", async () => {
  const target = await radar({ category: "perfil-teste" });
  const filteredTarget = await radar({ category: "perfil-teste", exclude_terms: ["defeito"] });
  const excluded = await importItems(filteredTarget.id, [item("profile-excluded", { title: "Camisa vintage defeito" })]);
  const isolatedTarget = await radar({ category: "outro-perfil" });
  const isolated = await importItems(isolatedTarget.id, [item("profile-isolated")]);
  const result = await importItems(target.id, [item("positive"), item("negative"), item("like-candidate"), item("dislike-candidate")]);
  // Synthetic stored embeddings exercise feedback without downloading CLIP.
  // This validates learning from existing vectors, not semantic inference.
  const database = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(path.join(directory, "radar.db"), (error) => error ? reject(error) : resolve(connection));
  });
  try {
    for (let i = 0; i < result.listings.length; i += 1) {
      await new Promise((resolve, reject) => database.run(
        "UPDATE listings SET image_embedding_json = ?, hybrid_score = 50, grail_score = 50, ranking_score = 50 WHERE id = ?",
        [JSON.stringify(i % 2 ? [0, 1] : [1, 0]), result.listings[i].id],
        (error) => error ? reject(error) : resolve(),
      ));
    }
  } finally {
    await new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
  }
  const [positive, negative, like, dislike] = result.listings;
  await api(`/api/listings/${positive.id}`, "PATCH", { status: "interessante" });
  await api(`/api/listings/${negative.id}`, "PATCH", { status: "descartado" });
  let rows = await listings(target.id);
  const liked = rows.find((row) => row.id === like.id);
  const disliked = rows.find((row) => row.id === dislike.id);
  assert.equal(liked.preference_score, 100);
  assert.equal(disliked.preference_score, 0);
  assert.ok(liked.grail_score > disliked.grail_score);
  assert.equal(liked.ranking_score, liked.grail_score);
  assert.equal(disliked.ranking_score, disliked.grail_score);
  assert.ok(rows.indexOf(liked) < rows.indexOf(disliked));
  // Learned taste must not override an exclusion or change another category.
  assert.equal((await listings(filteredTarget.id))[0].ranking_score, 0);
  assert.equal((await listings(filteredTarget.id))[0].id, excluded.listings[0].id);
  assert.equal((await listings(isolatedTarget.id))[0].ranking_score, isolated.listings[0].ranking_score);
  const { profiles } = await api("/api/preferences/status");
  assert.equal(profiles.find((profile) => profile.category === "perfil-teste").total_feedback, 2);
  assert.equal(profiles.find((profile) => profile.category === "outro-perfil").total_feedback, 0);
  await api("/api/listings/bulk", "POST", { action: "status", ids: [positive.id, negative.id], status: "novo" });
  rows = await listings(target.id);
  for (const row of rows) {
    assert.equal(row.preference_score, null);
    assert.equal(row.grail_score, 50);
    assert.equal(row.ranking_score, 50);
  }
});
