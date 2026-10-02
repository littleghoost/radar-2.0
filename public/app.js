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

function money(value) {
  if (value === null || value === undefined || value === "") {
    return "Preço não informado";
  }

  return Number(value).toLocaleString(
    "pt-BR",

    {
      style: "currency",

      currency: "BRL",
    },
  );
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

    alert(`${result.radar.name}\n\n` + result.message);
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

                  ${money(listing.first_price)}

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

                  ${money(listing.current_price)}

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
  };
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
    };

    const descriptions = {
      olx: "Conta da OLX para futuras integrações autorizadas.",

      mercadolivre: "Conecte sua conta do Mercado Livre.",

      ebay: "Conecte sua conta do eBay.",
    };

    const grid = $("#connectionsGrid");

    grid.innerHTML = connections
      .map((connection) => {
        const connected = connection.status === "connected";

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

                  ${connected ? "Conectado" : "Não conectado"}

                </span>

              </div>


              <p>

                ${descriptions[connection.provider]}

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
  const names = {
    olx: "OLX",

    mercadolivre: "Mercado Livre",

    ebay: "eBay",
  };

  alert(
    `Conexão com ${names[provider]} preparada.\n\n` +
      "Agora precisamos implementar o fluxo oficial de autorização dessa plataforma.",
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
