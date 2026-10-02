const state = {
  radars: [],

  listings: [],

  activeRadar: "",
};

const $ = (selector) => document.querySelector(selector);

const radarModal = $("#radarModal");

const listingModal = $("#listingModal");

$("#openRadarModal").onclick = () => radarModal.showModal();

$("#openListingModal").onclick = () => listingModal.showModal();

document.querySelectorAll(".close-modal").forEach((button) => {
  button.addEventListener(
    "click",

    () => {
      button.closest("dialog").close();
    },
  );
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

                </span>


                <h3>

                  ${escapeHtml(radar.name)}

                </h3>


                <p>

                  ${escapeHtml(radar.query)}

                </p>

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
                          ${money(radar.max_price)}
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

      ${options}

    `;

  $("#radarFilter").value = state.activeRadar;

  $("#listingRadarSelect").innerHTML = `

      <option value="">

        Sem radar

      </option>

      ${options}

    `;
}

/* =========================
   RODAR RADAR
========================= */

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
  const radar = state.radars.find((radar) => Number(radar.id) === Number(id));

  if (!radar) {
    return;
  }

  const name = prompt(
    "Nome do radar:",

    radar.name,
  );

  if (name === null) {
    return;
  }

  const query = prompt(
    "Busca / palavras-chave:",

    radar.query,
  );

  if (query === null) {
    return;
  }

  const maxPrice = prompt(
    "Preço máximo:",

    radar.max_price ?? "",
  );

  if (maxPrice === null) {
    return;
  }

  const category = prompt(
    "Categoria (roupas, cameras ou geral):",

    radar.category || "geral",
  );

  if (category === null) {
    return;
  }

  try {
    await api(
      `/api/radars/${id}`,

      {
        method: "PATCH",

        body: JSON.stringify({
          name,

          query,

          max_price: maxPrice,

          category,
        }),
      },
    );

    await loadRadars();

    await loadListings();
  } catch (err) {
    alert(err.message);
  }
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

  state.listings = await api(`/api/listings?${params.toString()}`);

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
              class="listing-card"
            >

              ${
                listing.image_url
                  ? `

                    <img

                      class="listing-image"

                      src="${escapeAttr(listing.image_url)}"

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

                </div>


                <h3>

                  ${escapeHtml(listing.title)}

                </h3>


                <div
                  class="price"
                >

                  ${money(listing.current_price, listing.currency)}

                </div>


                ${drop}


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
}

/* =========================
   CRIAR RADAR
========================= */

$("#radarForm").onsubmit = async (event) => {
  event.preventDefault();

  const formElement = event.currentTarget;

  const form = new FormData(formElement);

  const payload = Object.fromEntries(form.entries());

  try {
    await api(
      "/api/radars",

      {
        method: "POST",

        body: JSON.stringify(payload),
      },
    );

    formElement.reset();

    radarModal.close();

    await loadRadars();

    await loadListings();
  } catch (err) {
    alert(err.message);
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

    $("#activityStats").innerHTML = `
      <article><span>Execuções</span><strong>${runs.length}</strong></article>
      <article><span>Concluídas</span><strong>${completed}</strong></article>
      <article><span>Novos anúncios</span><strong>${newListings}</strong></article>
      <article><span>Quedas de preço</span><strong>${priceDrops}</strong></article>
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

      mercadolivre: "Conecte sua conta do Mercado Livre.",

      ebay: "Conecte sua conta do eBay.",
      depop: "API oficial de parceiros da Depop; não possui busca geral do marketplace.",
    };

    const grid = $("#connectionsGrid");

    grid.innerHTML = connections
      .map((connection) => {
        const connected = connection.status === "connected";
        const needsAuth = connection.status === "reauthorization_required";
        const pendingCredentials = connection.status === "pending_credentials";
        const pendingHomologation = connection.status === "pending_homologation";
        const partnerAccessRequired = connection.status === "partner_access_required";
        const accountLabel =
          connected && connection.provider_username
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
  } catch (err) {
    alert(err.message);
  }
}

/* =========================
   CONECTAR
========================= */

function connectProvider(provider) {
  if (provider === "mercadolivre") {
    window.location.href = "/auth/mercadolivre";
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

/* =========================
   INICIAR
========================= */

(async function init() {
  try {
    await loadRadars();

    await loadListings();
  } catch (err) {
    alert("Não consegui carregar o Radar: " + err.message);
  }
})();
