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
const unavailableImages = new Set(["/unavailable.png"]);
const imageRequests = new Map();

function png(red, green, blue) {
  const image = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data.set([red, green, blue, 255], i);
  }
  return PNG.sync.write(image);
}

async function api(route, method = "GET", body, expected = 200, timeout = 15000) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Runner Windows pode estar compilando recursos pesados em paralelo.
    signal: AbortSignal.timeout(timeout),
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
  const backend = process.env.RADAR_TEST_BACKEND;
  child = spawn(backend || process.execPath, backend ? [] : ["server/app.js"], {
    windowsHide: true,
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

async function importItems(radarId, items, overrides = {}, timeout = 15000) {
  return api("/api/import/assisted", "POST", {
    radar_id: radarId,
    source_url: "https://marketplace.example/busca",
    items,
    ...overrides,
  }, 200, timeout);
}

async function listings(radarId) {
  return api(`/api/listings?radar_id=${radarId}`);
}

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "radar-assisted-test-"));
  imageServer = http.createServer((req, res) => {
    imageRequests.set(req.url, (imageRequests.get(req.url) || 0) + 1);
    if (unavailableImages.has(req.url)) {
      res.writeHead(503);res.end("Image temporarily unavailable");return;
    }
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

test("Pesos e limites zerados persistem na criação e em edições parciais", async () => {
  const zero = {visual_weight:0,semantic_weight:0,criteria_weight:0,min_visual_similarity:0,alert_min_score:0,alert_price_drop_percent:0};
  const target = await radar(zero);
  for (const [key,value] of Object.entries(zero)) assert.equal(target[key],value,key);
  const renamed = await api(`/api/radars/${target.id}`, "PATCH", {name:"Radar renomeado"});
  for (const [key,value] of Object.entries(zero)) assert.equal(renamed[key],value,key);
  const defaults = await radar();
  const updated = await api(`/api/radars/${defaults.id}`, "PATCH", zero);
  for (const [key,value] of Object.entries(zero)) assert.equal(updated[key],value,key);
});

test("Peso visual zero usa apenas texto e preço na importação e reanálise", async () => {
  const target = await radar({visual_enabled:true,visual_weight:0,semantic_enabled:false,criteria_weight:0});
  const reference = await fetch(`${baseUrl}/api/radars/${target.id}/reference-image`, {method:"PUT",headers:{"content-type":"image/png"},body:png(255,0,0)});
  assert.equal(reference.status,200);
  const result = await importItems(target.id,[item("zero-visual",{image_url:imageUrl+"/blue.png"})]);
  const {hybridScore} = require("../server/services/visualSimilarity");
  const expected = hybridScore({visual:0,query:target.query,title:"Camisa vintage",price:80,maxPrice:200,currency:"BRL",visualWeight:0});
  assert.equal(result.listings[0].hybrid_score,expected);
  await api(`/api/radars/${target.id}/reindex-visual`,"POST");
  assert.equal((await listings(target.id))[0].hybrid_score,expected);
});

test("Falha ao baixar imagem não é apresentada como similaridade zero", async () => {
  const target = await radar({visual_enabled:true,semantic_enabled:false});
  const reference = await fetch(`${baseUrl}/api/radars/${target.id}/reference-image`, {method:"PUT",headers:{"content-type":"image/png"},body:png(255,0,0)});
  assert.equal(reference.status,200);
  const result = await importItems(target.id,[item("missing-image",{image_url:imageUrl+"/unavailable.png"})]);
  assert.equal(result.imported,1);
  assert.equal(result.listings[0].visual_score,null);
  assert.equal(result.listings[0].hybrid_score,100);
});

test("Imagem indisponível é reanalisada quando volta, mesmo sem outra alteração", async () => {
  unavailableImages.add('/recoverable.png');
  const target = await radar({visual_enabled:true,semantic_enabled:false});
  const reference = await fetch(`${baseUrl}/api/radars/${target.id}/reference-image`, {method:"PUT",headers:{"content-type":"image/png"},body:png(255,0,0)});
  assert.equal(reference.status,200);
  const original = item('recover-image',{image_url:imageUrl+'/recoverable.png'});
  const first = await importItems(target.id,[original]);
  assert.equal(first.listings[0].visual_score,null);
  unavailableImages.delete('/recoverable.png');
  const retry = await importItems(target.id,[original]);
  assert.equal(retry.updated,1);assert.equal(retry.imported,0);
  assert.equal(retry.listings[0].visual_score,100);
  const duplicate = await importItems(target.id,[original]);
  assert.equal(duplicate.duplicates,1);
});

test("Alterar apenas preço ou título reutiliza a análise da mesma foto", async () => {
  const target = await radar({visual_enabled:true,semantic_enabled:false});
  await fetch(`${baseUrl}/api/radars/${target.id}/reference-image`, {method:"PUT",headers:{"content-type":"image/png"},body:png(255,0,0)});
  const original = item('cached-image',{image_url:imageUrl+'/cached.png'});
  const first = await importItems(target.id,[original]);
  assert.equal(first.listings[0].visual_score,100);
  const requestsBefore = imageRequests.get('/cached.png');
  unavailableImages.add('/cached.png');
  try {
    const updated = await importItems(target.id,[{...original,title:'Camisa vintage estampada',current_price:70}]);
    assert.equal(updated.updated,1);assert.equal(updated.listings[0].visual_score,100);
    assert.equal(imageRequests.get('/cached.png'),requestsBefore);
  } finally {unavailableImages.delete('/cached.png');}
});

test("Reanálise paginada cobre mais de 500 anúncios sem repetir nem incluir chegadas novas", async () => {
  const target = await radar({semantic_enabled:false});
  const connection = await new Promise((resolve,reject)=>{
    const db = new sqlite3.Database(path.join(directory,'radar.db'),error=>error?reject(error):resolve(db));
  });
  try {
    await new Promise((resolve,reject)=>connection.run(
      `WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<503)
       INSERT INTO listings(radar_id,title,platform,url,current_price,status,hybrid_score)
       SELECT ?, 'Camisa vintage', 'Teste local', 'https://marketplace.example/reindex/'||n, 80, 'novo', 0 FROM seq`,
      [target.id],error=>error?reject(error):resolve(),
    ));
  } finally {await new Promise(resolve=>connection.close(resolve));}
  let afterId=0,throughId,analyzed=0,pages=0;
  while (true) {
    // A hosted Windows runner can take longer for a batch of 100 SQLite writes.
    const page = await api(`/api/radars/${target.id}/reindex-visual`,'POST',{after_id:afterId,through_id:throughId,limit:100},200,60000);
    assert.equal(page.total,503);assert.equal(page.failed,0);assert.ok(page.analyzed<=100);
    analyzed+=page.analyzed;pages++;
    assert.ok(page.next_after_id>afterId);
    afterId=page.next_after_id;throughId=page.through_id;
    if (pages===1) await importItems(target.id,[item('arrived-during-reindex')]);
    if (!page.has_more) break;
    assert.ok(pages<10,'pagination should finish');
  }
  assert.equal(analyzed,503);assert.equal(pages,6);
  assert.equal((await listings(target.id)).filter(row=>row.hybrid_score===100).length,504);
  await api(`/api/radars/${target.id}/reindex-visual`,'POST',{after_id:-1},400);
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
  // Esse lote de 100 imagens pode demorar mais no runner Windows compartilhado.
  // Mantemos o limite curto nos demais testes e ampliamos só nesta prova de carga.
  const limited = await importItems(target.id,
    Array.from({ length: 101 }, (_, i) => item(`limit-${i}`)), {}, 90000);
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

test('Feed filtra origem brasileira, internacional e desconhecida sem depender da moeda', async()=>{
  const marker='origin-regression-20261016';
  const records=[
    item('origin-br',{title:marker+' brasil',platform:'Mercado Livre',
      url:'https://produto.mercadolivre.com.br/MLB-9988776655-_JM',
      currency:'BRL'}),
    item('origin-world',{title:marker+' importado',platform:'eBay',
      url:'https://www.ebay.com/itm/998877665544',currency:'BRL'}),
    item('origin-unknown',{title:marker+' vendedor-indefinido',platform:'Shopee',
      url:'https://shopee.com.br/product/4567/89012',currency:'BRL'}),
  ];
  const imported=await importItems(null,records);
  assert.equal(imported.imported,3);
  const q=extra=>'/api/listings?search='+encodeURIComponent(marker)+'&'+extra;
  const everything=await api(q(''));
  assert.equal(everything.length,3);
  assert.deepEqual(new Set(everything.map(a=>a.region)),new Set(['br','international','unknown']));
  assert.equal((await api(q('region=br'))).length,1);
  assert.equal((await api(q('region=international')))[0].platform,'eBay');
  assert.equal((await api(q('region=unknown')))[0].platform,'Shopee');
  assert.equal((await api(q('platform=eBay'))).length,1);
  assert.equal((await api(q('region=br&platform=eBay'))).length,0);
  assert.equal((await api(q('region=international&platform=eBay'))).length,1);
});

test('Pré-inspeção corta JNC automotivo, mantém JNCO e não perde a contagem',async()=>{
  const clothes = await radar({
    name:'Treino JNCO',
    query:'JNCO | baggy jeans',
    category:'roupas',
    max_price:200,
  });
  const source_url='https://www.olx.com.br/brasil?q=JNCO';
  const input=[
    item('jnc-wheels',{title:'Rodas JNC aro 15 Furação 4x100',
      platform:'OLX',url:'https://pr.olx.com.br/autos-e-pecas/rodas-jnc-1461234567'}),
    item('jnco-real',{title:'JNCO wide leg embroidered baggy jeans',
      platform:'OLX',url:'https://pr.olx.com.br/roupas/jnco-jeans-1461234568'}),
  ];
  const saved=await importItems(clothes.id,input,{source_url});
  assert.equal(saved.filtered,1);
  assert.equal(saved.imported,1);
  assert.equal(saved.listings[0].title,input[1].title);
  const queued=await api('/api/training/queue?radar_id='+clothes.id+'&limit=12');
  assert.ok(queued.items.some(row=>row.id===saved.listings[0].id));
  assert.ok(!queued.items.some(row=>row.title.startsWith('Rodas JNC')));
  const vote=await api('/api/training/feedback','POST',
    {listing_id:saved.listings[0].id,radar_id:clothes.id,verdict:'rare'});
  assert.equal(vote.ok,true);
  const reviewed=await listings(clothes.id);
  assert.equal(reviewed.find(row=>row.id===saved.listings[0].id).status,'interessante');
  const next=await api('/api/training/queue?radar_id='+clothes.id);
  assert.ok(!next.items.some(row=>row.id===saved.listings[0].id));
  await api('/api/training/feedback','POST',
    {listing_id:saved.listings[0].id,radar_id:clothes.id,verdict:'rare'},409);
});

test('Treinar com Não sei não descarta a peça e não a repete',async()=>{
  const target=await radar({category:'roupas',query:'MCD vintage'});
  const saved=await importItems(target.id,[item('trainer-unsure',{title:'MCD caveira embroidered jacket'})]);
  const row=saved.listings[0];
  const response=await api('/api/training/feedback','POST',
    {listing_id:row.id,radar_id:target.id,verdict:'unsure'});
  assert.equal(response.verdict,'unsure');
  assert.equal((await listings(target.id)).find(x=>x.id===row.id).status,'novo');
  assert.ok(!(await api('/api/training/queue?radar_id='+target.id)).items.some(x=>x.id===row.id));
});

test('Avaliação Comum gera feedback negativo e melhora classificação textual sem embedding',async()=>{
  const target=await radar({category:'roupas',query:'JNCO vintage'});
  const good=await importItems(target.id,[item('trainer-good',{title:'JNCO dragon rhinestone baggy pants',image_url:imageUrl+'/red.png'})]);
  const bad=await importItems(target.id,[item('trainer-bad',{title:'Jeans liso básico skinny',image_url:imageUrl+'/red.png'})]);
  const third=await importItems(target.id,[item('trainer-third',{title:'JNCO dragon embroidered baggy',image_url:imageUrl+'/red.png'})]);
  await api('/api/training/feedback','POST',{listing_id:good.listings[0].id,radar_id:target.id,verdict:'rare'});
  const negative=await api('/api/training/feedback','POST',{listing_id:bad.listings[0].id,radar_id:target.id,verdict:'common'});
  assert.equal(negative.verdict,'common');
  const examples=await listings(target.id);
  const candidate=examples.find(x=>x.id===third.listings[0].id);
  assert.ok(Number.isFinite(candidate.preference_score));
  assert.ok(candidate.preference_score>50);
  assert.equal(examples.find(x=>x.id===bad.listings[0].id).status,'descartado');
});

test('Status visual por radar e lote proibido em ambiente sem CLIP',async()=>{
  const target=await radar({category:'roupas',semantic_enabled:false});
  const saved=await importItems(target.id,[
    item('trainer-visual-new',{title:'JNCO embroidered baggy pants'}),
    item('trainer-visual-positive',{title:'MCD rare vintage dragon'}),
  ]);
  await api('/api/training/feedback','POST',{
    radar_id:target.id,listing_id:saved.listings[1].id,verdict:'rare',
  });
  const status=await api('/api/training/images/status?radar_id='+target.id);
  assert.equal(status.with_image,2);
  assert.equal(status.indexed,0);
  assert.equal(status.pending,2);
  assert.equal(status.reviewed_pending,1);
  assert.equal(status.model.enabled,false);
  assert.equal(status.busy,false);
  await api('/api/training/images/batch','POST',{
    radar_id:target.id,scope:'reviewed',after_id:0,limit:1,
  },409);
  await api('/api/training/images/batch','POST',{
    radar_id:target.id,scope:'all',after_id:-5,limit:1,
  },400);
  await api('/api/training/images/status?radar_id=0',undefined,undefined,400);
  const untouched=await listings(target.id);
  assert.equal(untouched.filter(x=>x.image_embedding_json).length,0);
});

test("Avaliação de filmadora é bloqueada no radar de roupas, sem alterar registros existentes",async()=>{
  const radarClothes=await radar({name:"Grails teste",category:"roupas"});
  const title="Sony Handycam DCR SX 30 Camcorder Y2K";
  const saved=await importItems(radarClothes.id,[item("wrong-camera",{
    title,platform:"Vinted",url:"https://www.vinted.pt/items/700009999",
  })]);
  assert.equal(saved.imported,1);
  const row=saved.listings[0];
  const queue=await api("/api/training/queue?radar_id="+radarClothes.id);
  assert.ok(!queue.items.some(x=>x.id===row.id));
  await api("/api/training/feedback","POST",
    {radar_id:radarClothes.id,listing_id:row.id,verdict:"rare"},400);
  const untouched=(await listings(radarClothes.id)).find(x=>x.id===row.id);
  assert.equal(untouched.status,"novo");
  await api("/api/listings/"+row.id,"PATCH",{status:"interessante"});
  const excluded=await api("/api/preferences/status");
  const clothProfile=excluded.profiles.find(x=>x.category==="roupas");
  assert.ok(clothProfile.excluded_cross_category>=1);
  const stillSaved=(await listings(radarClothes.id)).find(x=>x.id===row.id);
  assert.equal(stillSaved.status,"interessante");
});

test("Fila por dúvida retorna prioridade e modo recente preserva escolha",async()=>{
 const target=await radar({category:"roupas",name:"Foco em roupas"});
 const saved=await importItems(target.id,[
   item("active-a",{title:"JNCO Dragon XXL Baggy Tribal Jeans"}),
   item("active-b",{title:"Calça básica lisa"}),
   item("active-c",{title:"Tapout caveira bordado"}),
 ]);
 assert.equal(saved.imported,3);
 const uncertain=await api("/api/training/queue?radar_id="+target.id+"&mode=uncertain");
 assert.equal(uncertain.mode,"uncertain");
 assert.ok(uncertain.items.length>=3);
 assert.ok(uncertain.items.every(row=>row.review_reason && Number.isFinite(row.review_priority)));
 const recent=await api("/api/training/queue?radar_id="+target.id+"&mode=recent");
 assert.equal(recent.mode,"recent");
 assert.ok(recent.items.some(row=>!row.review_reason));
});
test("Conferência de duplicatas pode ocultar alerta, nunca excluir anúncios",async()=>{
 const target=await radar({category:"roupas",name:"Catálogo seguro"});
 const title="JNCO calça bordada dragon cargo cintura larga";
 const saved=await importItems(target.id,[
   item("review-dup-1",{title,platform:"OLX"}),
   item("review-dup-2",{title,platform:"OLX"}),
 ]);
 assert.equal(saved.imported,2);
 const before=await api("/api/catalog/review?radar_id="+target.id);
 assert.ok(before.items.some(x=>x.code==="duplicate_title"));
 const flagged=before.items.find(x=>x.code==="duplicate_title");
 const result=await api("/api/catalog/review/dismiss","POST",{
   listing_id:flagged.id,code:flagged.code,
 });
 assert.equal(result.listing_preserved,true);
 const after=await api("/api/catalog/review?radar_id="+target.id);
 assert.ok(!after.items.some(x=>x.id===flagged.id&&x.code==="duplicate_title"));
 assert.equal((await listings(target.id)).length,2);
 await api("/api/catalog/review/dismiss","POST",{listing_id:999999,code:"duplicate_title"},404);
});
