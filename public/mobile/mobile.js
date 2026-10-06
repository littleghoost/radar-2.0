const DEFAULT_BASE = location.origin && /^https?:/.test(location.origin) ? location.origin : "";
const state = {
  baseUrl: localStorage.getItem("radarMobileBaseUrl") || DEFAULT_BASE,
  radars: [],
  listings: [],
  online: false,
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
  .replaceAll('"',"&quot;").replaceAll("'","&#039;");

function endpoint(path) {
  return `${state.baseUrl.replace(/\/$/,"")}${path}`;
}

async function api(path, options = {}) {
  if (!state.baseUrl) throw new Error("Configure o endereço do Radar.");
  const response = await fetch(endpoint(path), {
    headers: {"Content-Type":"application/json", ...(options.headers || {})},
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Radar respondeu ${response.status}`);
  return data;
}

function setConnection(online, message) {
  state.online = online;
  const pill = $("#connectionPill");
  pill.classList.toggle("online", online);
  pill.classList.toggle("offline", !online);
  $("#connectionText").textContent = message || (online ? "Desktop online" : "Desktop offline");
  $("#heroText").textContent = online
    ? "Sincronizado com o Radar Desktop. Seus achados estão prontos para triagem."
    : "O Desktop está offline. Você ainda pode abrir anúncios já carregados nesta sessão.";
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2200);
}

function money(value, currency = "BRL") {
  if (value === null || value === undefined || value === "") return "Preço —";
  try {
    return new Intl.NumberFormat("pt-BR", {style:"currency", currency:currency || "BRL"}).format(Number(value));
  } catch {
    return `${currency || "BRL"} ${value}`;
  }
}

function renderStats() {
  $("#statRadars").textContent = state.radars.length;
  $("#statListings").textContent = state.listings.length;
  $("#statInteresting").textContent = state.listings.filter(x => x.status === "interessante").length;
  $("#statNew").textContent = state.listings.filter(x => x.status === "novo").length;
}

function renderRadars() {
  const host = $("#radarsList");
  host.innerHTML = "";
  if (!state.radars.length) {
    host.innerHTML = '<div class="empty">Nenhum radar encontrado.</div>';
    return;
  }
  for (const radar of state.radars) {
    const node = $("#radarTemplate").content.firstElementChild.cloneNode(true);
    node.querySelector(".radar-category").textContent = radar.category || "geral";
    node.querySelector(".radar-name").textContent = radar.name;
    node.querySelector(".radar-query").textContent = radar.query || "Sem termos configurados";
    node.querySelector(".radar-count").textContent = radar.listing_count ?? 0;
    node.querySelector(".radar-schedule").textContent = radar.schedule_enabled
      ? `Ativo • a cada ${Math.round((radar.schedule_interval_minutes || 240) / 60)}h`
      : "Agendamento desligado";
    const button = node.querySelector(".run-button");
    button.addEventListener("click", async () => {
      button.disabled = true;
      const before = button.textContent;
      button.textContent = "Rodando…";
      try {
        await api(`/api/radars/${radar.id}/run`, {method:"POST", body:"{}"});
        toast("Radar executado.");
        await refresh();
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
        button.textContent = before;
      }
    });
    host.appendChild(node);
  }
}

function renderListings() {
  const host = $("#listingsList");
  const filter = $("#statusFilter").value;
  const listings = filter ? state.listings.filter(x => x.status === filter) : state.listings;
  host.innerHTML = "";
  if (!listings.length) {
    host.innerHTML = '<div class="empty">Nenhum anúncio nesse filtro.</div>';
    return;
  }
  for (const listing of listings.slice(0, 60)) {
    const node = $("#listingTemplate").content.firstElementChild.cloneNode(true);
    const link = node.querySelector(".listing-link");
    link.href = listing.url || "#";
    const img = node.querySelector(".listing-image");
    if (listing.image_url) img.src = listing.image_url;
    img.alt = listing.title || "Anúncio";
    node.querySelector(".listing-platform").textContent = listing.platform || "Radar";
    node.querySelector(".listing-title").textContent = listing.title || "Sem título";
    node.querySelector(".listing-price").textContent = money(listing.current_price, listing.currency);
    const score = listing.grail_score ?? listing.hybrid_score ?? listing.rule_score;
    node.querySelector(".listing-score").textContent = score === null || score === undefined ? "" : `score ${Math.round(score)}`;

    const updateStatus = async (status) => {
      try {
        await api(`/api/listings/${listing.id}`, {
          method:"PATCH",
          body:JSON.stringify({status}),
        });
        listing.status = status;
        renderListings();
        renderStats();
        toast(status === "interessante" ? "Guardado como interessante." : "Anúncio descartado.");
      } catch (error) {
        toast(error.message);
      }
    };
    node.querySelector(".interesting").addEventListener("click", () => updateStatus("interessante"));
    node.querySelector(".discard").addEventListener("click", () => updateStatus("descartado"));
    host.appendChild(node);
  }
}

async function refresh() {
  try {
    await api("/api/health");
    const [radars, listings] = await Promise.all([
      api("/api/radars"),
      api("/api/listings"),
    ]);
    state.radars = Array.isArray(radars) ? radars : [];
    state.listings = Array.isArray(listings) ? listings : [];
    setConnection(true);
    renderStats();
    renderRadars();
    renderListings();
  } catch (error) {
    setConnection(false, "Desktop offline");
    if (!state.radars.length) $("#radarsList").innerHTML = '<div class="empty">Conecte ao Radar Desktop para carregar seus radares.</div>';
    if (!state.listings.length) $("#listingsList").innerHTML = '<div class="empty">Sem conexão com o Radar.</div>';
  }
}

$("#refreshButton").addEventListener("click", refresh);
$("#statusFilter").addEventListener("change", renderListings);
$("#baseUrlInput").value = state.baseUrl;
$("#saveConnectionButton").addEventListener("click", async () => {
  const value = $("#baseUrlInput").value.trim().replace(/\/$/,"");
  if (!/^https?:\/\//i.test(value)) {
    toast("Use um endereço começando com http:// ou https://");
    return;
  }
  state.baseUrl = value;
  localStorage.setItem("radarMobileBaseUrl", value);
  toast("Endereço salvo.");
  await refresh();
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(x => x.classList.remove("active"));
    button.classList.add("active");
    const target = button.dataset.target;
    if (target === "top") scrollTo({top:0,behavior:"smooth"});
    else document.getElementById(target)?.scrollIntoView({behavior:"smooth",block:"start"});
  });
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

refresh();
setInterval(() => {
  if (document.visibilityState === "visible") refresh();
}, 60000);
