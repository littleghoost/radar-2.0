const state = {
  radars: [],

  listings: [],

  selectedListings: new Set(),

  activeRadar: "",
};

const $ = (selector) => document.querySelector(selector);

const radarModal = $("#radarModal");

const listingModal = $("#listingModal");

const importModal = $("#importModal");
const ebayModal = $("#ebayModal");

const INBOX_LABELS = {
  grail: "Grail",
  provavel: "Provável",
  talvez: "Talvez",
  triagem: "Triagem",
  ruido: "Ruído",
};

function inboxTierLabel(tier) {
  return INBOX_LABELS[tier] || "Triagem";
}

function parseRadarTerms(value) {
  if (Array.isArray(value)) return value;

  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(Boolean)
      : [];
  } catch {
    return String(value)
      .split(/[\n,;]+/)
      .map((term) => term.trim())
      .filter(Boolean);
  }
}

function setInboxFilter(tier) {
  const filter = $("#inboxFilter");

  if (!filter) return;

  filter.value = filter.value === tier ? "" : tier;
  loadListings();
}

function renderInboxSummary(listings) {
  const summary = $("#inboxSummary");
  if (!summary) return;

  const counts = {
    grail: 0,
    provavel: 0,
    talvez: 0,
    triagem: 0,
    ruido: 0,
  };

  listings.forEach((listing) => {
    const tier = listing.inbox_tier || "triagem";
    if (counts[tier] !== undefined) counts[tier] += 1;
  });

  summary.innerHTML = Object.entries(counts)
    .map(([tier, count]) => `
      <button
        type="button"
        class="inbox-summary-chip ${tier}"
        onclick="setInboxFilter('${tier}')"
      >
        <span>${inboxTierLabel(tier)}</span>
        <strong>${count}</strong>
      </button>
    `)
    .join("");
}

function listingImageUrl(url) {
  if (!url) return "";

  try {
    const parsed = new URL(url);

    if (
      parsed.hostname === "img.olx.com.br" ||
      parsed.hostname.endsWith(".img.olx.com.br")
    ) {
      return `/api/image-proxy?url=${encodeURIComponent(url)}`;
    }
  } catch {}

  return url;
}

function updateBulkActions() {
  const visibleIds = state.listings.map((listing) => Number(listing.id));
  const selectedVisible = visibleIds.filter((id) =>
    state.selectedListings.has(id),
  );
  const count = state.selectedListings.size;
  const hasSelection = count > 0;

  [
    "#deleteSelectedListings",
    "#moveSelectedListings",
    "#applySelectedStatus",
    "#autoAssignSelected",
    "#rescoreSelected",
    "#openSelectedLinks",
    "#copySelectedLinks",
    "#clearListingSelection",
  ].forEach((selector) => {
    const control = $(selector);
    if (control) control.disabled = !hasSelection;
  });

  const deleteButton = $("#deleteSelectedListings");
  if (deleteButton) {
    deleteButton.textContent = hasSelection ? `Excluir (${count})` : "Excluir";
  }

  const label = $("#bulkSelectionLabel");
  if (label) {
    label.textContent = hasSelection
      ? `${count} selecionado(s)`
      : "Selecionar todos visíveis";
  }

  const selectAll = $("#selectAllListings");

  if (selectAll) {
    selectAll.checked =
      visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
    selectAll.indeterminate =
      selectedVisible.length > 0 &&
      selectedVisible.length < visibleIds.length;
  }
}

function toggleListingSelection(id, checked) {
  const numericId = Number(id);

  if (checked) {
    state.selectedListings.add(numericId);
  } else {
    state.selectedListings.delete(numericId);
  }

  document
    .querySelector(`[data-listing-id="${numericId}"]`)
    ?.classList.toggle("selected", checked);

  updateBulkActions();
}

function toggleSelectAllListings(checked) {
  state.listings.forEach((listing) => {
    const id = Number(listing.id);

    if (checked) {
      state.selectedListings.add(id);
    } else {
      state.selectedListings.delete(id);
    }
  });

  document.querySelectorAll(".listing-select").forEach((input) => {
    input.checked = checked;
    input.closest(".listing-card")?.classList.toggle("selected", checked);
  });

  updateBulkActions();
}

async function runBulkListingAction(action, extra = {}) {
  const ids = [...state.selectedListings];

  if (!ids.length) {
    return null;
  }

  return api("/api/listings/bulk", {
    method: "POST",
    body: JSON.stringify({
      ids,
      action,
      ...extra,
    }),
  });
}

async function removeSelectedListings() {
  const count = state.selectedListings.size;

  if (!count) {
    return;
  }

  const confirmed = confirm(
    `Excluir ${count} anúncio(s) selecionado(s) do Radar?`,
  );

  if (!confirmed) {
    return;
  }

  try {
    await runBulkListingAction("delete");
    state.selectedListings.clear();
    await Promise.all([loadListings(), loadRadars()]);
  } catch (err) {
    alert(err.message);
    updateBulkActions();
  }
}

async function moveSelectedListings() {
  const radarId = $("#bulkRadarSelect")?.value;

  if (!radarId) {
    alert("Escolha um radar de destino.");
    return;
  }

  try {
    const result = await runBulkListingAction("move", {
      radar_id: radarId,
    });

    state.selectedListings.clear();
    await Promise.all([loadListings(), loadRadars()]);
    alert(`${result.affected} anúncio(s) movido(s).`);
  } catch (err) {
    alert(err.message);
  }
}

async function applySelectedStatus() {
  const status = $("#bulkStatusSelect")?.value;

  if (!status) {
    alert("Escolha um status.");
    return;
  }

  try {
    const result = await runBulkListingAction("status", { status });

    state.selectedListings.clear();
    await Promise.all([loadListings(), loadRadars()]);
    alert(`${result.affected} anúncio(s) atualizado(s).`);
  } catch (err) {
    alert(err.message);
  }
}

async function autoAssignSelectedListings() {
  try {
    const result = await runBulkListingAction("auto_assign");

    state.selectedListings.clear();
    await Promise.all([loadListings(), loadRadars()]);

    const extra = result.unassigned
      ? ` • ${result.unassigned} sem correspondência segura`
      : "";

    alert(`${result.affected} anúncio(s) auto-organizado(s)${extra}.`);
  } catch (err) {
    alert(err.message);
  }
}

async function rescoreSelectedListings() {
  try {
    const result = await runBulkListingAction("rescore");
    state.selectedListings.clear();
    await loadListings();

    const extra = result.skipped
      ? ` • ${result.skipped} sem radar`
      : "";

    alert(`${result.affected} anúncio(s) reanalisado(s)${extra}.`);
  } catch (err) {
    alert(err.message);
  }
}

function openSelectedLinks() {
  const selected = state.listings.filter((listing) =>
    state.selectedListings.has(Number(listing.id)),
  );

  if (!selected.length) return;

  if (
    selected.length > 8 &&
    !confirm(`Abrir ${selected.length} anúncios em novas abas?`)
  ) {
    return;
  }

  selected.forEach((listing) => {
    if (listing.url) {
      window.open(listing.url, "_blank", "noopener,noreferrer");
    }
  });
}

async function copySelectedLinks() {
  const selected = state.listings.filter((listing) =>
    state.selectedListings.has(Number(listing.id)),
  );

  const text = selected.map((listing) => listing.url).filter(Boolean).join("\n");

  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    alert(`${selected.length} link(s) copiado(s).`);
  } catch {
    prompt("Copie os links:", text);
  }
}

function clearListingSelection() {
  state.selectedListings.clear();

  document.querySelectorAll(".listing-select").forEach((input) => {
    input.checked = false;
    input.closest(".listing-card")?.classList.remove("selected");
  });

  updateBulkActions();
}

function resetRadarFormForCreate() {
  const form = $("#radarForm");
  if (!form) return;

  form.reset();
  delete form.dataset.editingRadarId;

  $("#radarModalEyebrow").textContent = "NOVO";
  $("#radarModalTitle").textContent = "Criar radar";
  $("#radarSubmitButton").textContent = "Criar radar";

  const label = $("#radarReferenceLabel");
  if (label) label.textContent = "Escolher imagem";
}

function openNewRadarModal() {
  resetRadarFormForCreate();
  radarModal.showModal();
}

$("#openRadarModal").onclick = openNewRadarModal;

$("#openListingModal").onclick = () => listingModal.showModal();

$("#openImportModal")?.addEventListener("click", () => importModal.showModal());


$("#radarReferenceImage")?.addEventListener("change", (event) => {
  const file = event.currentTarget.files?.[0];
  const label = $("#radarReferenceLabel");
  if (label) label.textContent = file ? file.name : "Escolher imagem";
});

document.querySelectorAll(".close-modal").forEach((button) => {
  button.addEventListener(
    "click",

    () => {
      button.closest("dialog").close();
    },
  );
});

/* =========================
   BROWSER BRIDGE
========================= */

function collectorBookmarklet() {
  const source = `(()=>{const d=location.hostname.toLowerCase();const names=[['olx','OLX'],['enjoei','Enjoei'],['depop','Depop'],['vinted','Vinted'],['facebook','Facebook Marketplace'],['ebay','eBay'],['mercadolivre','Mercado Livre'],['mercadolibre','Mercado Libre']];const platform=(names.find(([k])=>d.includes(k))||[])[1]||d.replace(/^www\\./,'');const abs=(u)=>{try{return new URL(u,location.href).href}catch{return null}};const clean=(u)=>{try{const x=new URL(u);x.hash='';['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid'].forEach(k=>x.searchParams.delete(k));return x.href}catch{return u}};const parsePrice=(text)=>{const m=String(text||'').match(/(?:R\\$|US\\$|USD|EUR|€|GBP|£|\\$)\\s*([0-9][0-9.,\\s]*)/i);if(!m)return {price:null,currency:'BRL'};const sym=m[0].slice(0,m[0].indexOf(m[1])).trim().toUpperCase();let raw=m[1].replace(/\\s/g,'');let currency=sym.includes('R$')?'BRL':sym.includes('€')||sym.includes('EUR')?'EUR':sym.includes('£')||sym.includes('GBP')?'GBP':'USD';if(currency==='BRL'||currency==='EUR'){if(raw.includes(','))raw=raw.replace(/\\./g,'').replace(',','.');else if((raw.match(/\\./g)||[]).length>1)raw=raw.replace(/\\./g,'')}else{if(raw.includes('.')&&raw.includes(','))raw=raw.replace(/,/g,'');else if((raw.match(/,/g)||[]).length===1&&/,[0-9]{2}$/.test(raw))raw=raw.replace(',','.');else raw=raw.replace(/,/g,'')}const n=Number(raw);return {price:Number.isFinite(n)?n:null,currency}};const candidates=[...document.querySelectorAll('a[href]')];const out=[];const seen=new Set();for(const a of candidates){if(out.length>=80)break;const url=clean(abs(a.getAttribute('href')));if(!url||seen.has(url)||!/^https?:/.test(url))continue;let card=a.closest('article,li,[data-testid*="item"],[data-testid*="card"],[class*="listing"],[class*="product"],[class*="card"]');if(!card){card=a;for(let i=0;i<4&&card.parentElement;i++)card=card.parentElement}const img=card.querySelector('img')||a.querySelector('img');if(!img)continue;const text=(card.innerText||a.innerText||'').replace(/\\s+/g,' ').trim();if(text.length<8)continue;const h=card.querySelector('h1,h2,h3,h4,[role="heading"]');let title=(h?.innerText||img.alt||a.getAttribute('title')||a.innerText||text).replace(/\\s+/g,' ').trim();if(title.length>180)title=title.slice(0,180);if(title.length<3)continue;const {price,currency}=parsePrice(text);const image=abs(img.currentSrc||img.src||img.getAttribute('data-src')||'');seen.add(url);out.push({title,platform,url,image_url:image,current_price:price,currency})}const payload=JSON.stringify({version:1,source_url:location.href,platform,captured_at:new Date().toISOString(),items:out},null,2);const done=()=>alert('Radar: '+out.length+' anúncio(s) copiado(s). Agora cole no Importar página.');navigator.clipboard?.writeText(payload).then(done).catch(()=>prompt('Copie esta captura do Radar:',payload));if(!navigator.clipboard)prompt('Copie esta captura do Radar:',payload)})()`;
  return `javascript:${source.replace(/\n/g, "")}`;
}

function parseImportPayload() {
  const text = $("#importPayload")?.value?.trim();
  if (!text) throw new Error("Cole primeiro a captura gerada pelo coletor.");
  const data = JSON.parse(text);
  const items = Array.isArray(data) ? data : data.items;
  if (!Array.isArray(items)) throw new Error("A captura não contém uma lista de anúncios.");
  return {
    source_url: Array.isArray(data) ? null : data.source_url || null,
    platform: Array.isArray(data) ? null : data.platform || null,
    items: items.filter((item) => item && item.url && item.title).slice(0, 100),
  };
}

function renderImportPreview() {
  const preview = $("#importPreview");
  try {
    const data = parseImportPayload();
    if ($("#importSourceUrl") && data.source_url && !$("#importSourceUrl").value) {
      $("#importSourceUrl").value = data.source_url;
    }
    const withImages = data.items.filter((item) => item.image_url).length;
    const withPrices = data.items.filter((item) => item.current_price !== null && item.current_price !== undefined).length;
    preview.innerHTML = `<strong>${data.items.length} anúncio(s) detectado(s)</strong><br>${withImages} com imagem • ${withPrices} com preço${data.platform ? ` • ${escapeHtml(data.platform)}` : ""}`;
    return data;
  } catch (err) {
    preview.textContent = err.message;
    return null;
  }
}

$("#copyCollector")?.addEventListener("click", async () => {
  const button = $("#copyCollector");
  try {
    await navigator.clipboard.writeText(collectorBookmarklet());
    const old = button.textContent;
    button.textContent = "Coletor copiado";
    setTimeout(() => { button.textContent = old; }, 1800);
  } catch {
    prompt("Copie este código e use como URL de um favorito:", collectorBookmarklet());
  }
});

$("#pasteImportPayload")?.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) throw new Error("A área de transferência está vazia.");
    $("#importPayload").value = text;
    renderImportPreview();
  } catch (err) {
    alert(err.message || "Não consegui ler a área de transferência.");
  }
});

$("#previewImport")?.addEventListener("click", renderImportPreview);
$("#importPayload")?.addEventListener("input", () => {
  const preview = $("#importPreview");
  if (preview) preview.textContent = "Captura alterada. Clique em Analisar captura.";
});

$("#importForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const data = renderImportPreview();
  if (!data || !data.items.length) return;
  button.disabled = true;
  button.textContent = "Importando...";
  try {
    const result = await api("/api/import/assisted", {
      method: "POST",
      body: JSON.stringify({
        radar_id: form.elements.radar_id.value || null,
        source_url: form.elements.source_url.value || data.source_url || null,
        items: data.items,
      }),
    });
    $("#importPreview").innerHTML = `<strong>${result.imported} importado(s)</strong> • ${result.duplicates} duplicado(s) • ${result.invalid} inválido(s) • ${result.failed} falha(s)`;
    await Promise.all([loadListings(), loadRadars(), loadActivity().catch(() => {})]);
    if (result.imported > 0) setTimeout(() => importModal.close(), 1200);
  } catch (err) {
    alert(err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Importar anúncios";
  }
});

/* =========================
   DINHEIRO
========================= */

function money(value, currency = "BRL") {
  if (value === null || value === undefined || value === "") {
    return "Preço não informado";
  }

  return Number(value).toLocaleString(
    "pt-BR",

    {
      style: "currency",

      currency: currency || "BRL",
    },
  );
}

function internationalCostHtml(listing) {
  const cost = listing?.international_cost;

  if (!cost) return "";

  const headline = cost.shipping_known
    ? `Estimado entregue: ${money(cost.total_brl, "BRL")}`
    : `Mínimo estimado: ${money(cost.total_brl, "BRL")} + frete`;

  const program =
    cost.program === "prc"
      ? "Remessa Conforme"
      : "fora do Remessa Conforme";

  const handling =
    Number(cost.handling_fee_brl || 0) > 0
      ? `
        <div class="international-cost-row">
          <span>Taxa extra</span>
          <strong>${escapeHtml(
            money(cost.handling_fee_brl, "BRL"),
          )}</strong>
        </div>
      `
      : "";

  const fx =
    cost.fx_rate_to_brl &&
    listing.currency &&
    String(listing.currency).toUpperCase() !== "BRL"
      ? `1 ${escapeHtml(String(listing.currency).toUpperCase())} ≈ ${escapeHtml(
          money(cost.fx_rate_to_brl, "BRL"),
        )}`
      : "";

  return `
    <div class="international-cost">
      <div class="international-cost-head">
        <span>CUSTO NO BRASIL</span>
        <strong>${escapeHtml(headline)}</strong>
      </div>

      <div class="international-cost-breakdown">
        <div class="international-cost-row">
          <span>Produto convertido</span>
          <strong>${escapeHtml(
            money(cost.product_brl, "BRL"),
          )}</strong>
        </div>

        <div class="international-cost-row">
          <span>Frete</span>
          <strong>
            ${
              cost.shipping_known
                ? escapeHtml(
                    money(cost.shipping_brl, "BRL"),
                  )
                : "não confirmado"
            }
          </strong>
        </div>

        <div class="international-cost-row">
          <span>Imposto de Importação</span>
          <strong>${escapeHtml(
            money(cost.import_tax_brl, "BRL"),
          )}</strong>
        </div>

        <div class="international-cost-row">
          <span>ICMS (${escapeHtml(
            String(cost.icms_rate_percent),
          )}%)</span>
          <strong>${escapeHtml(
            money(cost.icms_brl, "BRL"),
          )}</strong>
        </div>

        ${handling}
      </div>

      <small class="muted">
        ${escapeHtml(program)}
        ${
          cost.origin_country
            ? ` · origem: ${escapeHtml(
                String(cost.origin_country).toUpperCase(),
              )}`
            : ""
        }
        ${fx ? ` · ${fx}` : ""}
        ${
          cost.fx_source
            ? ` · câmbio: ${escapeHtml(cost.fx_source)}`
            : ""
        }
      </small>

      ${
        cost.shipping_known
          ? `<small class="international-cost-ok">Frete informado pelo eBay para o contexto de entrega configurado.</small>`
          : `<small class="international-cost-warning">Frete ainda não incluído. Adicione seu CEP em Perfil → Importação para melhorar o cálculo do eBay.</small>`
      }
    </div>
  `;
}

function dateTime(value) {
  if (!value) return "Nunca executado";
  const normalized = String(value).includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/* =========================
   API
========================= */

async function api(url, options = {}) {
  const response = await fetch(
    url,

    {
      headers: {
        "Content-Type": "application/json",

        ...(options.headers || {}),
      },

      ...options,
    },
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Erro na operação.");
  }

  return data;
}

/* =========================
   CARREGAR RADARES
========================= */

async function loadRadars() {
  state.radars = await api("/api/radars");

  $("#statRadars").textContent = state.radars.length;

  const radarList = $("#radarList");

  if (!state.radars.length) {
    radarList.innerHTML = `

      <div class="empty">

        Nenhum radar ainda.

        Crie o primeiro.

      </div>

    `;
  } else {
    radarList.innerHTML = state.radars
      .map((radar) => {
        const active = String(state.activeRadar) === String(radar.id);
        const priorityTerms = parseRadarTerms(
          radar.priority_terms_json,
        );
        const penalizedTerms = parseRadarTerms(
          radar.penalized_terms_json,
        );
        const requiredTerms = parseRadarTerms(
          radar.required_terms_json,
        );
        const excludeTerms = parseRadarTerms(
          radar.exclude_terms_json,
        );

        return `

              <article

                class="
                  radar-card
                  ${active ? "active" : ""}
                "

                data-radar="${radar.id}"

              >

                <span class="eyebrow">

                  ${escapeHtml(radar.category || "GERAL")}
                  ${radar.visual_enabled ? " • VISUAL" : ""}${radar.reference_embedding_json ? " • IA" : ""}

                </span>

                ${
                  radar.visual_enabled && radar.reference_image_path
                    ? `<div class="radar-reference-wrap"><img class="radar-reference-image" src="/api/radars/${radar.id}/reference-image" alt="Imagem de referência do radar"></div>`
                    : ""
                }


                <h3>

                  ${escapeHtml(radar.name)}

                </h3>


                <p>

                  ${escapeHtml(radar.query)}

                </p>

                ${
                  priorityTerms.length ||
                  penalizedTerms.length ||
                  requiredTerms.length ||
                  excludeTerms.length
                    ? `
                      <div class="radar-criteria-preview">
                        ${priorityTerms.slice(0, 4).map((term) => `
                          <span class="criteria-chip priority">↑ ${escapeHtml(term)}</span>
                        `).join("")}
                        ${penalizedTerms.slice(0, 3).map((term) => `
                          <span class="criteria-chip penalized">↓ ${escapeHtml(term)}</span>
                        `).join("")}
                        ${requiredTerms.slice(0, 3).map((term) => `
                          <span class="criteria-chip required">✓ ${escapeHtml(term)}</span>
                        `).join("")}
                        ${excludeTerms.slice(0, 3).map((term) => `
                          <span class="criteria-chip exclude">× ${escapeHtml(term)}</span>
                        `).join("")}
                      </div>
                    `
                    : ""
                }

                <p class="radar-last-run">
                  Última execução: ${escapeHtml(dateTime(radar.last_run_at))}
                  ${radar.last_run_status ? ` • ${escapeHtml(radar.last_run_status)}` : ""}
                </p>

                <p class="radar-schedule">
                  ${
                    radar.schedule_enabled
                      ? `Agendamento preparado: a cada ${Math.round((radar.schedule_interval_minutes || 240) / 60)}h • próxima ${escapeHtml(dateTime(radar.next_run_at))}`
                      : "Execução manual"
                  }
                </p>


                <div class="meta">

                  <span>

                    ${
                      radar.max_price
                        ? `
                          até
                          ${money(
                            radar.max_price,
                            radar.budget_currency || "BRL",
                          )}
                        `
                        : "sem teto"
                    }

                  </span>


                  <span>

                    ${radar.listing_count}

                    anúncios

                  </span>

                </div>


                <div
                  class="card-actions"
                  style="
                    margin-top:14px;
                  "
                >

                  <button

                    class="primary"

                    onclick="
                      event.stopPropagation();
                      runRadar(${radar.id});
                    "

                  >

                    Rodar radar

                  </button>


                  <button

                    class="secondary"

                    onclick="
                      event.stopPropagation();
                      configureSchedule(${radar.id});
                    "

                  >

                    Agendamento

                  </button>

                  ${
                    radar.visual_enabled
                      ? `<button class="secondary" onclick="event.stopPropagation(); reindexVisualRadar(${radar.id}, this);">Reanalisar IA</button>`
                      : ""
                  }

                  <button

                    class="secondary"

                    onclick="
                      event.stopPropagation();
                      editRadar(${radar.id});
                    "

                  >

                    Editar

                  </button>


                  <button

                    class="
                      danger-btn
                      wide-action
                    "

                    onclick="
                      event.stopPropagation();
                      removeRadar(${radar.id});
                    "

                  >

                    Excluir radar

                  </button>

                </div>

              </article>

            `;
      })
      .join("");
  }

  document.querySelectorAll(".radar-card").forEach((card) => {
    card.onclick = () => {
      const id = card.dataset.radar;

      state.activeRadar = String(state.activeRadar) === String(id) ? "" : id;

      $("#radarFilter").value = state.activeRadar;

      loadRadars();

      loadListings();
    };
  });

  const options = state.radars
    .map(
      (radar) => `

          <option
            value="${radar.id}"
          >

            ${escapeHtml(radar.name)}

          </option>

        `,
    )
    .join("");

  $("#radarFilter").innerHTML = `

      <option value="">

        Todos os radares

      </option>

      <option value="none">

        Sem radar

      </option>

      ${options}

    `;

  $("#radarFilter").value = state.activeRadar;

  $("#listingRadarSelect").innerHTML = `

      <option value="">

        Sem radar

      </option>

      ${options}

    `;

  if ($("#importRadar")) {
    $("#importRadar").innerHTML = `<option value="">Sem radar</option>${options}`;
  }

  if ($("#bulkRadarSelect")) {
    $("#bulkRadarSelect").innerHTML =
      `<option value="">Mover para radar...</option><option value="none">Sem radar</option>${options}`;
  }
}

/* =========================
   RODAR RADAR
========================= */

async function reindexVisualRadar(id, button) {
  const original = button?.textContent || "Reanalisar IA";
  if (button) {
    button.disabled = true;
    button.textContent = "Analisando...";
  }
  try {
    const result = await api(`/api/radars/${id}/reindex-visual`, { method: "POST" });
    if (button) button.textContent = `${result.analyzed} analisado(s)`;
    await loadListings();
    setTimeout(() => { if (button) button.textContent = original; }, 1800);
  } catch (err) {
    alert(err.message);
    if (button) button.textContent = original;
  } finally {
    if (button) button.disabled = false;
  }
}

async function runRadar(id) {
  try {
    const result = await api(
      `/api/radars/${id}/run`,

      {
        method: "POST",
      },
    );

    await loadRadars();
    await loadListings();

    await loadDesktopSettings();
    await loadNotifications();
    await loadNotifications();
    if ($("#activityPage")?.classList.contains("active")) await loadActivity();

    alert(`${result.radar.name}\n\n` + result.message);
  } catch (err) {
    alert(err.message);
  }
}

/* =========================
   AGENDAMENTO PREPARADO
========================= */

async function configureSchedule(id) {
  const radar = state.radars.find((item) => Number(item.id) === Number(id));
  if (!radar) return;

  if (radar.schedule_enabled) {
    const disable = confirm(
      "Este radar está com agendamento preparado.\n\nOK = desligar agendamento\nCancelar = manter como está",
    );
    if (!disable) return;

    try {
      await api(`/api/radars/${id}/schedule`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      });
      await loadRadars();
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  const hours = prompt(
    "Preparar este radar para rodar a cada quantas horas?\n\nO Fly NÃO executará sozinho por enquanto. Isso deixa a configuração pronta para o futuro app/servidor.",
    "4",
  );
  if (hours === null) return;

  const value = Number(hours.replace?.(",", ".") ?? hours);
  if (!Number.isFinite(value) || value < 1) {
    alert("Use um intervalo de pelo menos 1 hora.");
    return;
  }

  try {
    await api(`/api/radars/${id}/schedule`, {
      method: "PATCH",
      body: JSON.stringify({
        enabled: true,
        interval_minutes: Math.round(value * 60),
      }),
    });
    await loadRadars();
  } catch (err) {
    alert(err.message);
  }
}

/* =========================
   EDITAR RADAR
========================= */

async function editRadar(id) {
  const radar = state.radars.find(
    (item) => Number(item.id) === Number(id),
  );

  if (!radar) return;

  const form = $("#radarForm");
  if (!form) return;

  form.reset();
  form.dataset.editingRadarId = String(radar.id);

  form.elements.name.value = radar.name || "";
  form.elements.query.value = radar.query || "";
  form.elements.max_price.value =
    radar.max_price ?? "";
  form.elements.budget_currency.value =
    radar.budget_currency || "BRL";
  form.elements.category.value =
    radar.category || "geral";
  form.elements.priority_terms.value =
    parseRadarTerms(radar.priority_terms_json).join("\n");
  form.elements.penalized_terms.value =
    parseRadarTerms(radar.penalized_terms_json).join("\n");
  form.elements.required_terms.value =
    parseRadarTerms(radar.required_terms_json).join("\n");
  form.elements.exclude_terms.value =
    parseRadarTerms(radar.exclude_terms_json).join("\n");
  form.elements.criteria_weight.value =
    String(radar.criteria_weight ?? 65);
  form.elements.visual_weight.value =
    String(radar.visual_weight ?? 70);
  form.elements.semantic_enabled.checked =
    Boolean(radar.semantic_enabled);
  form.elements.semantic_weight.value =
    String(radar.semantic_weight ?? 70);
  form.elements.min_visual_similarity.value =
    String(radar.min_visual_similarity ?? 0.45);

  $("#radarModalEyebrow").textContent = "EDITAR";
  $("#radarModalTitle").textContent =
    `Editar ${radar.name}`;
  $("#radarSubmitButton").textContent =
    "Salvar radar";

  const label = $("#radarReferenceLabel");
  if (label) {
    label.textContent = radar.reference_image_path
      ? "Trocar imagem de referência"
      : "Escolher imagem";
  }

  radarModal.showModal();
}

/* =========================
   EXCLUIR RADAR
========================= */

async function removeRadar(id) {
  const radar = state.radars.find((radar) => Number(radar.id) === Number(id));

  const confirmed = confirm(
    `Excluir o radar "${radar?.name || "selecionado"}"?\n\n` +
      "Os anúncios salvos NÃO serão apagados.",
  );

  if (!confirmed) {
    return;
  }

  try {
    await api(
      `/api/radars/${id}`,

      {
        method: "DELETE",
      },
    );

    if (String(state.activeRadar) === String(id)) {
      state.activeRadar = "";
    }

    await loadRadars();

    await loadListings();
  } catch (err) {
    alert(err.message);
  }
}

/* =========================
   PISTAS DE CATÁLOGO
========================= */

async function loadCatalogDiscoveries(radarId = "") {
  const panel = $("#catalogPanel");
  const grid = $("#catalogDiscoveries");
  const count = $("#catalogCount");

  if (!panel || !grid || !count) return;

  const params = new URLSearchParams();
  if (radarId) params.set("radar_id", radarId);

  const items = await api(
    `/api/catalog-discoveries?${params.toString()}`,
  );

  count.textContent = String(items.length);
  panel.hidden = items.length === 0;

  if (!items.length) {
    grid.innerHTML = "";
    return;
  }

  grid.innerHTML = items
    .slice(0, 12)
    .map((item) => {
      const query = item.metadata?.search_query
        ? `Busca: ${escapeHtml(item.metadata.search_query)}`
        : "";

      return `
        <article class="catalog-card">
          <strong>${escapeHtml(item.title)}</strong>
          <div class="catalog-meta">
            ${item.external_id ? `<span>${escapeHtml(item.external_id)}</span>` : ""}
            ${item.domain_id ? `<span>${escapeHtml(item.domain_id)}</span>` : ""}
            ${item.radar_name ? `<span>${escapeHtml(item.radar_name)}</span>` : ""}
          </div>
          ${query ? `<small class="muted">${query}</small>` : ""}
          ${item.url ? `<a href="${escapeAttr(item.url)}" target="_blank" rel="noopener">Abrir produto de catálogo</a>` : ""}
        </article>
      `;
    })
    .join("");
}

/* =========================
   CARREGAR ANÚNCIOS
========================= */

async function loadListings() {
  const params = new URLSearchParams();

  const radar = $("#radarFilter").value;

  const status = $("#statusFilter").value;

  const search = $("#searchInput").value.trim();

  if (radar) {
    params.set("radar_id", radar);
  }

  if (status) {
    params.set("status", status);
  }

  if (search) {
    params.set("search", search);
  }

  const fetchedListings = await api(`/api/listings?${params.toString()}`);

  await loadCatalogDiscoveries(radar).catch(() => {});

  renderInboxSummary(fetchedListings);

  const inbox = $("#inboxFilter")?.value || "";

  state.listings = inbox
    ? fetchedListings.filter((listing) => listing.inbox_tier === inbox)
    : fetchedListings;

  const sort = $("#sortFilter")?.value || "default";

  if (sort !== "default") {
    const numeric = (value, fallback = 0) => {
      if (value === null || value === undefined || value === "") {
        return fallback;
      }

      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    };

    state.listings.sort((a, b) => {
      if (sort === "inbox_desc") {
        return numeric(b.inbox_score) - numeric(a.inbox_score);
      }

      if (sort === "recent") {
        return new Date(b.updated_at || b.created_at || 0) -
          new Date(a.updated_at || a.created_at || 0);
      }

      if (sort === "price_asc") {
        return numeric(a.current_price, Number.POSITIVE_INFINITY) -
          numeric(b.current_price, Number.POSITIVE_INFINITY);
      }

      if (sort === "price_desc") {
        return numeric(b.current_price, Number.NEGATIVE_INFINITY) -
          numeric(a.current_price, Number.NEGATIVE_INFINITY);
      }

      if (sort === "grail_desc") {
        return numeric(b.grail_score) - numeric(a.grail_score);
      }

      if (sort === "score_desc") {
        return numeric(b.hybrid_score) - numeric(a.hybrid_score);
      }

      return 0;
    });
  }

  const visibleIds = new Set(
    state.listings.map((listing) => Number(listing.id)),
  );

  state.selectedListings = new Set(
    [...state.selectedListings].filter((id) => visibleIds.has(id)),
  );

  const allListings = await api("/api/listings");

  $("#statListings").textContent = allListings.length;

  $("#statInteresting").textContent = allListings.filter(
    (listing) => listing.status === "interessante",
  ).length;

  const grid = $("#listingGrid");

  if (!state.listings.length) {
    grid.innerHTML = `

      <div class="empty">

        Nenhum anúncio encontrado.

      </div>

    `;

    updateBulkActions();
    return;
  }

  grid.innerHTML = state.listings
    .map((listing) => {
      const drop =
        listing.first_price &&
        listing.current_price &&
        Number(listing.current_price) < Number(listing.first_price)
          ? `

                <div
                  class="price-drop"
                >

                  ↓ caiu de

                  ${money(listing.first_price, listing.currency)}

                </div>

              `
          : "";

      return `

            <article
              class="listing-card ${state.selectedListings.has(Number(listing.id)) ? "selected" : ""}"
              data-listing-id="${listing.id}"
            >

              <label
                class="listing-select-wrap"
                title="Selecionar anúncio"
              >
                <input
                  class="listing-select"
                  type="checkbox"
                  ${state.selectedListings.has(Number(listing.id)) ? "checked" : ""}
                  onchange="toggleListingSelection(${listing.id}, this.checked)"
                />
              </label>

              ${
                listing.image_url
                  ? `

                    <img

                      class="listing-image"

                      src="${escapeAttr(listingImageUrl(listing.image_url))}"

                      alt=""

                    >

                  `
                  : `

                    <div
                      class="listing-image"
                    >
                    </div>

                  `
              }


              <div
                class="listing-body"
              >

                <div
                  class="platform-row"
                >

                  <span>

                    ${escapeHtml(listing.platform)}

                  </span>


                  <span

                    class="
                      status
                      ${listing.status}
                    "

                  >

                    ${escapeHtml(listing.status)}

                  </span>

                  ${
                    listing.availability_status === "unavailable"
                      ? `<span class="availability unavailable">INDISPONÍVEL</span>`
                      : listing.availability_status === "available"
                        ? `<span class="availability available">ONLINE</span>`
                        : ""
                  }

                </div>

                <div class="inbox-row">
                  <span class="inbox-tier ${escapeAttr(listing.inbox_tier || "triagem")}">
                    ${escapeHtml(inboxTierLabel(listing.inbox_tier))}
                    ${listing.inbox_score !== null && listing.inbox_score !== undefined ? ` · ${Math.round(Number(listing.inbox_score))}` : ""}
                  </span>
                </div>

                <h3>

                  ${escapeHtml(listing.title)}

                </h3>


                <div
                  class="price"
                >

                  ${money(listing.current_price, listing.currency)}

                </div>

                ${internationalCostHtml(listing)}

                ${drop}

                ${
                  Array.isArray(listing.tags) && listing.tags.length
                    ? `
                      <div class="tag-row">
                        ${listing.tags
                          .map(
                            (tag) =>
                              `<span class="auto-tag">${escapeHtml(tag)}</span>`,
                          )
                          .join("")}
                      </div>
                    `
                    : ""
                }

                ${
                  listing.score_reason
                    ? `
                      <p class="score-explanation">
                        ${escapeHtml(listing.score_reason)}
                      </p>
                    `
                    : ""
                }

                ${
                  listing.hybrid_score !== null && listing.hybrid_score !== undefined
                    ? `
                      <div class="score-row">
                        <span class="score-chip">Score ${Math.round(Number(listing.hybrid_score))}/100</span>
                        ${
                          listing.rule_score !== null && listing.rule_score !== undefined
                            ? `<span class="score-chip rule">Regras ${Math.round(Number(listing.rule_score))}/100${listing.rule_tier ? ` · ${escapeHtml(listing.rule_tier)}` : ""}</span>`
                            : ""
                        }
                        ${
                          listing.grail_score !== null && listing.grail_score !== undefined
                            ? `<span class="score-chip grail">Grail ${Math.round(Number(listing.grail_score))}/100</span>`
                            : ""
                        }
                        ${
                          listing.preference_score !== null && listing.preference_score !== undefined
                            ? `<span class="score-chip taste">Seu gosto ${Math.round(Number(listing.preference_score))}%</span>`
                            : ""
                        }
                        ${
                          listing.visual_score !== null && listing.visual_score !== undefined
                            ? `<span class="score-chip">Imagem ${Math.round(Number(listing.visual_score))}%</span>`
                            : ""
                        }
                        ${
                          listing.semantic_score !== null && listing.semantic_score !== undefined
                            ? `<span class="score-chip semantic">IA ${Math.round(Number(listing.semantic_score))}%</span>`
                            : ""
                        }
                      </div>
                    `
                    : ""
                }


                ${
                  listing.radar_name
                    ? `

                      <p
                        class="notes"
                      >

                        Radar:

                        ${escapeHtml(listing.radar_name)}

                      </p>

                    `
                    : ""
                }


                ${
                  listing.notes
                    ? `

                      <p
                        class="notes"
                      >

                        ${escapeHtml(listing.notes)}

                      </p>

                    `
                    : ""
                }


                <div
                  class="card-actions"
                >

                  <a

                    class="
                      primary
                      wide-action
                    "

                    href="${escapeAttr(listing.url)}"

                    target="_blank"

                    rel="noreferrer"

                    style="
                      text-decoration:none;
                      text-align:center;
                    "

                  >

                    Abrir anúncio

                  </a>


                  <button

                    class="secondary"

                    onclick="
                      setStatus(
                        ${listing.id},
                        'interessante'
                      )
                    "

                  >

                    ★ Interessante

                  </button>


                  <button

                    class="secondary"

                    onclick="
                      editPrice(
                        ${listing.id},
                        ${listing.current_price ?? "null"}
                      )
                    "

                  >

                    R$ Atualizar

                  </button>


                  <button

                    class="secondary"

                    onclick="
                      setStatus(
                        ${listing.id},
                        'descartado'
                      )
                    "

                  >

                    Descartar

                  </button>


                  <button

                    class="secondary"

                    onclick="
                      setStatus(
                        ${listing.id},
                        'vendido'
                      )
                    "

                  >

                    Vendido

                  </button>


                  <button

                    class="
                      danger-btn
                      wide-action
                    "

                    onclick="
                      removeListing(
                        ${listing.id}
                      )
                    "

                  >

                    Excluir

                  </button>

                </div>

              </div>

            </article>

          `;
    })
    .join("");

  updateBulkActions();
}

$("#selectAllListings")?.addEventListener("change", (event) => {
  toggleSelectAllListings(event.currentTarget.checked);
});

$("#deleteSelectedListings")?.addEventListener(
  "click",
  removeSelectedListings,
);

$("#moveSelectedListings")?.addEventListener(
  "click",
  moveSelectedListings,
);

$("#applySelectedStatus")?.addEventListener(
  "click",
  applySelectedStatus,
);

$("#autoAssignSelected")?.addEventListener(
  "click",
  autoAssignSelectedListings,
);

$("#rescoreSelected")?.addEventListener(
  "click",
  rescoreSelectedListings,
);

$("#openSelectedLinks")?.addEventListener(
  "click",
  openSelectedLinks,
);

$("#copySelectedLinks")?.addEventListener(
  "click",
  copySelectedLinks,
);

$("#clearListingSelection")?.addEventListener(
  "click",
  clearListingSelection,
);

/* =========================
   CRIAR RADAR
========================= */

$("#radarForm").onsubmit = async (event) => {
  event.preventDefault();

  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const editingRadarId =
    formElement.dataset.editingRadarId || null;
  const referenceImage =
    formElement.elements.reference_image?.files?.[0] || null;

  const payload = {
    name: form.get("name"),
    query: form.get("query"),
    max_price: form.get("max_price"),
    budget_currency:
      form.get("budget_currency") || "BRL",
    category: form.get("category"),
    priority_terms: form.get("priority_terms"),
    penalized_terms: form.get("penalized_terms"),
    required_terms: form.get("required_terms"),
    exclude_terms: form.get("exclude_terms"),
    criteria_weight: Number(
      form.get("criteria_weight") || 65,
    ),
    visual_weight: Number(
      form.get("visual_weight") || 70,
    ),
    semantic_enabled:
      formElement.elements.semantic_enabled.checked,
    semantic_weight: Number(
      form.get("semantic_weight") || 70,
    ),
    min_visual_similarity: Number(
      form.get("min_visual_similarity") || 0.45,
    ),
  };

  if (!editingRadarId) {
    payload.visual_enabled = Boolean(referenceImage);
  }

  const submitButton =
    formElement.querySelector('button[type="submit"]');
  const normalLabel = editingRadarId
    ? "Salvar radar"
    : "Criar radar";

  try {
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = editingRadarId
        ? "Salvando..."
        : "Criando...";
    }

    const radar = await api(
      editingRadarId
        ? `/api/radars/${editingRadarId}`
        : "/api/radars",
      {
        method: editingRadarId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      },
    );

    if (referenceImage) {
      if (submitButton) {
        submitButton.textContent =
          payload.semantic_enabled
            ? "Preparando IA visual..."
            : "Analisando imagem...";
      }

      const response = await fetch(
        `/api/radars/${radar.id}/reference-image`,
        {
          method: "PUT",
          headers: {
            "Content-Type":
              referenceImage.type ||
              "application/octet-stream",
          },
          body: referenceImage,
        },
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error ||
            "Não consegui enviar a imagem de referência.",
        );
      }
    }

    resetRadarFormForCreate();
    radarModal.close();

    await loadRadars();
    await loadListings();
  } catch (err) {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = normalLabel;
    }

    alert(errorMessage(err));
  }
};

/* =========================
   CRIAR ANÚNCIO
========================= */

$("#listingForm").onsubmit = async (event) => {
  event.preventDefault();

  const formElement = event.currentTarget;

  const form = new FormData(formElement);

  const payload = Object.fromEntries(form.entries());

  try {
    await api(
      "/api/listings",

      {
        method: "POST",

        body: JSON.stringify(payload),
      },
    );

    formElement.reset();

    listingModal.close();

    await loadListings();

    await loadRadars();

    if (["interessante", "descartado"].includes(status)) {
      await loadPreferenceStatus();
    }
  } catch (err) {
    alert(err.message);
  }
};

/* =========================
   STATUS
========================= */

async function setStatus(id, status) {
  try {
    await api(
      `/api/listings/${id}`,

      {
        method: "PATCH",

        body: JSON.stringify({
          status,
        }),
      },
    );

    await loadListings();

    await loadRadars();
  } catch (err) {
    alert(err.message);
  }
}

/* =========================
   PREÇO
========================= */

async function editPrice(id, current) {
  const value = prompt(
    "Novo preço:",

    current ?? "",
  );

  if (value === null) {
    return;
  }

  try {
    await api(
      `/api/listings/${id}`,

      {
        method: "PATCH",

        body: JSON.stringify({
          current_price: value,
        }),
      },
    );

    await loadListings();
  } catch (err) {
    alert(err.message);
  }
}

/* =========================
   EXCLUIR ANÚNCIO
========================= */

async function removeListing(id) {
  const confirmed = confirm("Excluir esse anúncio do Radar?");

  if (!confirmed) {
    return;
  }

  try {
    await api(
      `/api/listings/${id}`,

      {
        method: "DELETE",
      },
    );

    await loadListings();

    await loadRadars();
  } catch (err) {
    alert(err.message);
  }
}

/* =========================
   FILTROS
========================= */

$("#radarFilter").onchange = (event) => {
  state.activeRadar = event.target.value;

  loadRadars();

  loadListings();
};

$("#statusFilter").onchange = loadListings;

$("#inboxFilter").onchange = loadListings;

$("#sortFilter").onchange = loadListings;

/* =========================
   PESQUISA
========================= */

let searchTimer;

$("#searchInput").oninput = () => {
  clearTimeout(searchTimer);

  searchTimer = setTimeout(
    loadListings,

    200,
  );
};

/* =========================
   ESCAPE HTML
========================= */

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")

    .replaceAll("<", "&lt;")

    .replaceAll(">", "&gt;")

    .replaceAll('"', "&quot;")

    .replaceAll("'", "&#039;");
}

function escapeAttr(value = "") {
  return escapeHtml(value);
}
/* =========================
   NAVEGAÇÃO
========================= */

document.querySelectorAll(".nav-button").forEach((button) => {
  button.onclick = () => {
    const page = button.dataset.page;

    document.querySelectorAll(".nav-button").forEach((item) => {
      item.classList.remove("active");
    });

    button.classList.add("active");

    document.querySelectorAll(".page").forEach((section) => {
      section.classList.remove("active");
    });

    const target = document.querySelector(`#${page}Page`);

    if (target) {
      target.classList.add("active");
    }

    if (page === "connections") {
      loadConnections();
    }

    if (page === "activity") {
      loadActivity();
    }
  };
});

async function loadNotifications() {
  try {
    const summary = await api("/api/notifications/summary");
    const total = Number(summary.unseen_total || 0);
    const badge = $("#activityBadge");
    const stat = $("#statUnseen");

    if (stat) stat.textContent = total;
    if (badge) {
      badge.textContent = total > 99 ? "99+" : String(total);
      badge.hidden = total === 0;
    }

    return summary;
  } catch {
    return null;
  }
}

/* =========================
   ATIVIDADE
========================= */

function activityIcon(type) {
  return {
    new_listing: "+",
    price_drop: "↓",
    listing_unavailable: "−",
    listing_available: "↺",
    auto_capture: "↧",
    assisted_import: "↧",
    catalog_discovery: "◇",
    source_error: "!",
    run_failed: "×",
    run_completed: "✓",
  }[type] || "•";
}

async function loadActivity() {
  try {
    const [events, runs] = await Promise.all([
      api("/api/activity?limit=80"),
      api("/api/runs?limit=30"),
    ]);

    const completed = runs.filter((run) => run.status === "completed").length;
    const failed = runs.filter((run) => run.status === "failed").length;
    const newListings = events.filter((event) => event.type === "new_listing").length;
    const priceDrops = events.filter((event) => event.type === "price_drop").length;
    const unavailable = events.filter((event) => event.type === "listing_unavailable").length;

    $("#activityStats").innerHTML = `
      <article><span>Execuções</span><strong>${runs.length}</strong></article>
      <article><span>Concluídas</span><strong>${completed}</strong></article>
      <article><span>Novos anúncios</span><strong>${newListings}</strong></article>
      <article><span>Quedas de preço</span><strong>${priceDrops}</strong></article>
      <article><span>Indisponíveis</span><strong>${unavailable}</strong></article>
      ${failed ? `<article><span>Falhas</span><strong>${failed}</strong></article>` : ""}
    `;

    const list = $("#activityList");
    if (!events.length) {
      list.innerHTML = `<div class="empty">Nenhuma atividade registrada ainda. Rode um radar para começar.</div>`;
      return;
    }

    list.innerHTML = events
      .map((event) => {
        const link = event.listing_url
          ? `<a href="${escapeAttr(event.listing_url)}" target="_blank" rel="noopener">Abrir anúncio</a>`
          : "";

        return `
          <article class="activity-item ${escapeAttr(event.type)}">
            <div class="activity-icon">${activityIcon(event.type)}</div>
            <div class="activity-body">
              <div class="activity-top">
                <strong>${escapeHtml(event.title)}</strong>
                <time>${escapeHtml(dateTime(event.created_at))}</time>
              </div>
              ${event.detail ? `<p>${escapeHtml(event.detail)}</p>` : ""}
              <div class="activity-meta">
                ${event.radar_name ? `<span>${escapeHtml(event.radar_name)}</span>` : ""}
                ${event.listing_platform ? `<span>${escapeHtml(event.listing_platform)}</span>` : ""}
                ${link}
              </div>
            </div>
          </article>`;
      })
      .join("");
  } catch (err) {
    $("#activityList").innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

$("#refreshActivity")?.addEventListener("click", async () => {
  await loadActivity();
  await loadNotifications();
});

$("#markActivitySeen")?.addEventListener("click", async () => {
  try {
    await api("/api/notifications/mark-seen", { method: "POST" });
    await Promise.all([loadActivity(), loadNotifications()]);
  } catch (err) {
    alert(err.message);
  }
});

/* =========================
   CONEXÕES
========================= */

async function loadConnections() {
  try {
    const connections = await api("/api/connections");

    const names = {
      olx: "OLX",

      mercadolivre: "Mercado Livre",

      ebay: "eBay",
      depop: "Depop",
    };

    const descriptions = {
      olx: "Conta da OLX para futuras integrações autorizadas.",

      mercadolivre:
        "Busca automática oficial, atualização de preço e verificação de disponibilidade.",

      ebay:
        "Busca automática oficial via Browse API usando suas credenciais do eBay Developer.",
      depop: "API oficial de parceiros da Depop; não possui busca geral do marketplace.",
    };

    const grid = $("#connectionsGrid");

    const providerCards = connections
      .map((connection) => {
        const connected = connection.status === "connected";
        const needsAuth = connection.status === "reauthorization_required";
        const pendingCredentials = connection.status === "pending_credentials";
        const pendingHomologation = connection.status === "pending_homologation";
        const partnerAccessRequired = connection.status === "partner_access_required";
        const accountLabel =
          connected && connection.provider === "ebay"
            ? `eBay Developer conectado • ${escapeHtml(connection.provider_username || "marketplace configurado")}`
            : connected && connection.provider_username
              ? `Conta conectada: @${escapeHtml(connection.provider_username)}`
              : pendingCredentials
              ? "Cadastro do eBay Developer aguardando aprovação/credenciais."
              : pendingHomologation
                ? "Integração oficial da OLX aguardando homologação."
                : partnerAccessRequired
                  ? "Acesso à API de parceiros da Depop ainda não concedido. A API oficial não oferece busca geral do marketplace."
                  : descriptions[connection.provider];

        return `

            <article
              class="connection-card"
            >

              <div
                class="connection-top"
              >

                <span
                  class="connection-name"
                >

                  ${names[connection.provider]}

                </span>


                <span

                  class="
                    connection-status

                    ${connected ? "connected" : "disconnected"}
                  "

                >

                  ${connected ? "Conectado" : needsAuth ? "Reconectar" : pendingCredentials || pendingHomologation || partnerAccessRequired ? "Aguardando" : "Não conectado"}

                </span>

              </div>


              <p>

                ${accountLabel}

              </p>


              ${
                connected
                  ? `

                    <button
                      class="danger-btn"

                      onclick="
                        disconnectProvider(
                          '${connection.provider}'
                        )
                      "
                    >

                      Desconectar

                    </button>

                  `
                  : pendingCredentials || pendingHomologation || partnerAccessRequired
                    ? `<button class="secondary" type="button" disabled>${pendingHomologation ? "Aguardando homologação" : partnerAccessRequired ? "Aguardando acesso" : "Aguardando aprovação"}</button>`
                    : `

                    <button
                      class="primary"

                      onclick="
                        connectProvider(
                          '${connection.provider}'
                        )
                      "
                    >

                      Conectar

                    </button>

                  `
              }

            </article>

          `;
      })
      .join("");

    grid.innerHTML = `${providerCards}
      <article class="connection-card">
        <div class="connection-top">
          <span class="connection-name">Radar 2.0 Bridge</span>
          <span class="connection-status connected">Desktop</span>
        </div>
        <p>Extensão local para enviar anúncios visíveis de OLX, Enjoei, Depop, Vinted, Marketplace e outros sites direto para o Radar.</p>
        <button class="primary" type="button" onclick="showExtensionInstall()">Como instalar</button>
      </article>
    `;
  } catch (err) {
    alert(err.message);
  }
}

function showExtensionInstall() {
  alert(
    "Radar 2.0 Bridge\n\n" +
      "1. Abra opera://extensions no Opera GX.\n" +
      "2. Ative o Modo do desenvolvedor.\n" +
      "3. Clique em Carregar sem compactação.\n" +
      "4. Escolha a pasta 'Radar 2.0 Bridge' na sua Área de Trabalho.\n\n" +
      "Depois é só abrir um marketplace, clicar na extensão, escolher o radar e enviar os anúncios."
  );
}

/* =========================
   CONECTAR
========================= */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScheduledRadarsAfterConnection() {
  try {
    await loadRadars();

    const enabled = state.radars
      .filter((radar) => Boolean(radar.schedule_enabled))
      .slice(0, 5);

    for (const radar of enabled) {
      await api(`/api/radars/${radar.id}/run`, {
        method: "POST",
        body: JSON.stringify({ trigger: "source_connected" }),
      }).catch(() => null);
    }

    await Promise.all([
      loadListings(),
      loadActivity(),
      loadNotifications(),
    ]);
  } catch {
    // A conexão continua válida mesmo se a primeira rodada falhar.
  }
}

let mercadoLivreConnectAttempt = 0;

function errorMessage(error) {
  if (error?.message) return String(error.message);
  if (typeof error === "string") return error;
  try {
    const text = JSON.stringify(error);
    if (text && text !== "{}") return text;
  } catch {}
  return "Falha inesperada ao conectar o Mercado Livre.";
}

async function connectMercadoLivre() {
  const attempt = ++mercadoLivreConnectAttempt;
  let missingCount = 0;

  try {
    const start = await api("/api/mercadolivre/connect/start", {
      method: "POST",
      body: "{}",
    });

    if (attempt !== mercadoLivreConnectAttempt) return;

    if (start.mode === "web") {
      if (!start.auth_url) {
        throw new Error("O servidor não retornou a URL de autorização.");
      }

      window.location.href = start.auth_url;
      return;
    }

    if (!start.pairing_id) {
      throw new Error("O pareamento do Desktop não foi criado.");
    }

    if (!start.browser_opened) {
      throw new Error(
        "O Radar criou o pareamento, mas não conseguiu abrir o navegador.",
      );
    }

    if (attempt !== mercadoLivreConnectAttempt) return;

    const deadline =
      Date.now() +
      Number(start.expires_in_seconds || 900) * 1000;

    while (
      attempt === mercadoLivreConnectAttempt &&
      Date.now() < deadline
    ) {
      await delay(1800);

      if (attempt !== mercadoLivreConnectAttempt) return;

      let status;

      try {
        status = await api(
          `/api/mercadolivre/connect/status?pairing_id=${encodeURIComponent(start.pairing_id)}`,
        );
      } catch (err) {
        if (attempt !== mercadoLivreConnectAttempt) return;
        throw err;
      }

      if (status.status === "connected") {
        await loadConnections();
        await runScheduledRadarsAfterConnection();

        if (attempt !== mercadoLivreConnectAttempt) return;

        alert(
          status.provider_username
            ? `Mercado Livre conectado como @${status.provider_username}. Primeira rodada automática concluída.`
            : "Mercado Livre conectado. Primeira rodada automática concluída.",
        );
        return;
      }

      if (status.status === "missing") {
        missingCount += 1;

        if (missingCount < 3) {
          continue;
        }
      } else {
        missingCount = 0;
      }

      if (["error", "expired", "missing"].includes(status.status)) {
        if (attempt !== mercadoLivreConnectAttempt) return;

        throw new Error(
          status.error ||
            "A autorização expirou. Tente conectar novamente.",
        );
      }
    }

    if (attempt !== mercadoLivreConnectAttempt) return;

    throw new Error(
      "A autorização demorou demais. Tente conectar novamente.",
    );
  } catch (err) {
    if (attempt !== mercadoLivreConnectAttempt) return;
    alert(errorMessage(err));
  }
}

async function openEbayConfig() {
  const form = $("#ebayForm");
  if (!form || !ebayModal) return;

  form.reset();

  try {
    const config = await api("/api/ebay/config");

    if (config.client_id) {
      form.elements.client_id.value = config.client_id;
    }

    if (config.marketplace_id) {
      form.elements.marketplace_id.value =
        config.marketplace_id;
    }
  } catch {}

  ebayModal.showModal();
}

$("#ebayForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const original = button?.textContent || "Conectar";

  if (button) {
    button.disabled = true;
    button.textContent = "Testando credenciais...";
  }

  try {
    const result = await api("/api/ebay/configure", {
      method: "POST",
      body: JSON.stringify({
        client_id: form.elements.client_id.value.trim(),
        client_secret:
          form.elements.client_secret.value.trim(),
        marketplace_id:
          form.elements.marketplace_id.value,
      }),
    });

    ebayModal.close();
    await loadConnections();
    await runScheduledRadarsAfterConnection();

    alert(
      `eBay conectado para ${result.marketplace_id || "o marketplace selecionado"}. Primeira rodada automática concluída.`,
    );
  } catch (err) {
    alert(errorMessage(err));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
});

function connectProvider(provider) {
  if (provider === "mercadolivre") {
    connectMercadoLivre();
    return;
  }

  if (provider === "ebay") {
    openEbayConfig();
    return;
  }

  const names = {
    olx: "OLX",
    ebay: "eBay",
    depop: "Depop",
  };

  alert(
    `Conexão com ${names[provider]} ainda não está disponível.`,
  );
}

/* =========================
   DESCONECTAR
========================= */

async function disconnectProvider(provider) {
  const confirmed = confirm("Desconectar esta conta?");

  if (!confirmed) {
    return;
  }

  try {
    await api(
      `/api/connections/${provider}`,

      {
        method: "DELETE",
      },
    );

    await loadConnections();
  } catch (err) {
    alert(err.message);
  }
}


/* =========================
   IMPORTAR LINK MERCADO LIVRE
========================= */

$("#importMercadoLivreBtn")?.addEventListener("click", async () => {
  const form = $("#listingForm");
  const url = form.elements.url.value.trim();

  if (!url) {
    alert("Cole primeiro o link direto do anúncio do Mercado Livre.");
    return;
  }

  const button = $("#importMercadoLivreBtn");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Buscando...";

  try {
    const item = await api(
      `/api/mercadolivre/item?url=${encodeURIComponent(url)}`,
    );

    form.elements.title.value = item.title || "";
    form.elements.platform.value = item.platform || "Mercado Livre";
    form.elements.current_price.value = item.current_price ?? "";
    form.elements.url.value = item.url || url;
    form.elements.image_url.value = item.image_url || "";
  } catch (err) {
    alert(err.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});


async function loadPreferenceStatus() {
  const container = $("#tasteProfileStats");
  if (!container) return;
  try {
    const data = await api("/api/preferences/status");
    const profiles = data.profiles || [];
    if (!profiles.length || profiles.every((profile) => !profile.total_feedback)) {
      container.innerHTML = `<p class="muted">Ainda não há feedback suficiente. Marque anúncios como <strong>interessante</strong> ou <strong>descartado</strong> e o Radar começa a aprender automaticamente.</p>`;
      return;
    }
    container.innerHTML = profiles
      .map((profile) => `
        <div class="taste-stat">
          <strong>${escapeHtml(profile.category || "geral")}</strong>
          <span>${profile.positive_count} interessante(s)</span>
          <span>${profile.negative_count} descartado(s)</span>
          <span>${profile.total_feedback >= 8 ? "perfil forte" : "aprendendo"}</span>
        </div>
      `)
      .join("");
  } catch (err) {
    container.textContent = "Não consegui carregar o perfil de gosto.";
  }
}

$("#rebuildTasteProfile")?.addEventListener("click", async () => {
  const button = $("#rebuildTasteProfile");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Recalculando...";
  try {
    const result = await api("/api/preferences/rebuild", {
      method: "POST",
      body: JSON.stringify({}),
    });
    button.textContent = `${result.updated || 0} atualizado(s)`;
    await Promise.all([loadPreferenceStatus(), loadListings()]);
    setTimeout(() => { button.textContent = original; }, 1800);
  } catch (err) {
    alert(err.message);
    button.textContent = original;
  } finally {
    button.disabled = false;
  }
});

async function loadSemanticStatus() {
  const label = $("#semanticAvailability");
  const checkbox = $("#radarForm")?.elements?.semantic_enabled;
  if (!label) return;
  try {
    const status = await api("/api/semantic/status");
    if (status.enabled) {
      label.textContent = status.ready
        ? "IA local pronta para uso."
        : "IA local disponível. O primeiro radar pode baixar o modelo e levar alguns segundos.";
      if (checkbox) checkbox.disabled = false;
    } else {
      label.textContent = "IA semântica disponível no app desktop; nesta versão web o radar visual clássico continua ativo.";
      if (checkbox) {
        checkbox.checked = false;
        checkbox.disabled = true;
      }
    }
  } catch {
    label.textContent = "Não consegui verificar a IA semântica agora.";
  }
}

/* =========================
   CUSTO INTERNACIONAL
========================= */

function renderInternationalFxStatus(settings) {
  const label = $("#internationalFxStatus");
  if (!label) return;

  const usd = Number(settings?.fx?.rates?.USD);
  const source = settings?.fx?.source;

  if (Number.isFinite(usd) && usd > 0) {
    label.textContent =
      `Cotação atual: US$ 1 ≈ ${money(usd, "BRL")} · ${source || "fonte cambial"}`;
    return;
  }

  if (settings?.fx_error) {
    label.textContent =
      "Cotação temporariamente indisponível. A estimativa volta automaticamente quando a fonte responder.";
    return;
  }

  label.textContent =
    settings?.enabled === false
      ? "Estimativa desativada."
      : "Cotação: aguardando.";
}

async function loadInternationalCostSettings() {
  const form = $("#internationalCostForm");
  if (!form) return;

  const status = $("#internationalCostStatus");

  try {
    const settings = await api(
      "/api/international-cost/settings",
    );

    form.elements.enabled.checked =
      Boolean(settings.enabled);
    form.elements.program.value =
      settings.program || "outside_prc";
    form.elements.icms_rate_percent.value =
      String(settings.icms_rate_percent ?? 20);
    form.elements.handling_fee_brl.value =
      String(settings.handling_fee_brl ?? 0);
    form.elements.destination_postal_code.value =
      settings.destination_postal_code || "";

    renderInternationalFxStatus(settings);

    if (status) {
      status.textContent = "Pronto";
      status.classList.remove("saved");
    }
  } catch (err) {
    if (status) status.textContent = "Indisponível";
  }
}

$("#internationalCostForm")?.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const button =
      form.querySelector('button[type="submit"]');
    const status = $("#internationalCostStatus");

    if (button) button.disabled = true;
    if (status) status.textContent = "Salvando...";

    try {
      const settings = await api(
        "/api/international-cost/settings",
        {
          method: "PATCH",
          body: JSON.stringify({
            enabled: form.elements.enabled.checked,
            program: form.elements.program.value,
            icms_rate_percent: Number(
              form.elements.icms_rate_percent.value,
            ),
            handling_fee_brl: Number(
              form.elements.handling_fee_brl.value,
            ),
            destination_postal_code:
              form.elements.destination_postal_code.value.trim(),
          }),
        },
      );

      renderInternationalFxStatus(settings);

      if (status) {
        status.textContent = "Salvo";
        status.classList.add("saved");
      }

      await loadListings();
    } catch (err) {
      if (status) status.textContent = "Erro ao salvar";
      alert(errorMessage(err));
    } finally {
      if (button) button.disabled = false;
    }
  },
);

/* =========================
   CONFIGURAÇÕES DESKTOP
========================= */

async function loadDesktopSettings() {
  const form = $("#desktopSettingsForm");
  if (!form) return;

  const status = $("#desktopSettingsStatus");
  try {
    const settings = await api("/api/desktop/settings");
    for (const [key, value] of Object.entries(settings)) {
      const field = form.elements[key];
      if (!field) continue;
      if (field.type === "checkbox") field.checked = Boolean(value);
      else field.value = String(value);
    }
    if (status) {
      status.textContent = "Pronto";
      status.classList.remove("saved");
    }
  } catch (err) {
    if (status) status.textContent = "Indisponível";
  }
}

$("#desktopSettingsForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = $("#desktopSettingsStatus");
  if (button) button.disabled = true;
  if (status) status.textContent = "Salvando...";

  const payload = {
    autostart_enabled: form.elements.autostart_enabled.checked,
    background_enabled: form.elements.background_enabled.checked,
    poll_interval_minutes: Number(form.elements.poll_interval_minutes.value),
    notify_new_listings: form.elements.notify_new_listings.checked,
    notify_price_drops: form.elements.notify_price_drops.checked,
    notify_unavailable: form.elements.notify_unavailable.checked,
    notify_errors: form.elements.notify_errors.checked,
    start_minimized: form.elements.start_minimized.checked,
  };

  try {
    await api("/api/desktop/settings", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    if (status) {
      status.textContent = "Salvo";
      status.classList.add("saved");
    }
  } catch (err) {
    if (status) status.textContent = "Erro ao salvar";
    alert(err.message);
  } finally {
    if (button) button.disabled = false;
  }
});

$("#runBackgroundNow")?.addEventListener("click", async () => {
  const button = $("#runBackgroundNow");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Rodando...";
  try {
    const result = await api("/api/scheduler/run-due", {
      method: "POST",
      body: JSON.stringify({ limit: 5 }),
    });
    button.textContent = `Concluído (${result.due ?? result.results?.length ?? result.ran ?? result.length ?? 0})`;
    await Promise.all([loadRadars(), loadActivity(), loadNotifications()]);
    setTimeout(() => {
      button.textContent = original;
    }, 1800);
  } catch (err) {
    alert(err.message);
    button.textContent = original;
  } finally {
    button.disabled = false;
  }
});

/* =========================
   INICIAR
========================= */

(async function init() {
  try {
    await loadRadars();

    await loadListings();
    await Promise.all([
      loadDesktopSettings(),
      loadInternationalCostSettings(),
      loadSemanticStatus(),
      loadPreferenceStatus(),
      loadNotifications().catch(() => {}),
    ]);
  } catch (err) {
    alert("Não consegui carregar o Radar: " + err.message);
  }
})();
