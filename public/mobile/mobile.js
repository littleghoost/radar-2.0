const DEFAULT_BASE =
  location.origin && /^https?:/.test(location.origin)
    ? location.origin
    : "";

const STORAGE = {
  mode: "radarMobileMode",
  baseUrl: "radarMobileBaseUrl",
  relayUrl: "radarMobileRelayUrl",
  mobileId: "radarMobileId",
  mobileKey: "radarMobileKey",
  desktopId: "radarMobileDesktopId",
  cachedSnapshot: "radarMobileCachedSnapshot",
};

const relayCredentials = () => ({
  relayUrl:
    localStorage.getItem(STORAGE.relayUrl) ||
    (location.origin && /^https?:/.test(location.origin)
      ? location.origin
      : ""),
  mobileId: localStorage.getItem(STORAGE.mobileId) || "",
  mobileKey: localStorage.getItem(STORAGE.mobileKey) || "",
  desktopId: localStorage.getItem(STORAGE.desktopId) || "",
});

function hasRelayCredentials() {
  const current = relayCredentials();
  return Boolean(
    current.relayUrl &&
      current.mobileId &&
      current.mobileKey,
  );
}

const state = {
  mode: hasRelayCredentials() ? "relay" : "local",
  baseUrl:
    localStorage.getItem(STORAGE.baseUrl) ||
    DEFAULT_BASE,
  radars: [],
  listings: [],
  activity: [],
  visualReferences: [],
  pendingVisual: null,
  online: false,
  relayStatus: null,
  snapshotSyncedAt: null,
};

const $ = (selector) => document.querySelector(selector);

function endpoint(path) {
  return `${state.baseUrl.replace(/\/$/, "")}${path}`;
}

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data.error ||
        `Radar respondeu ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return data;
}

async function api(path, options = {}) {
  if (!state.baseUrl) {
    throw new Error("Configure o endereço do Radar.");
  }

  const response = await fetch(endpoint(path), {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  return parseResponse(response);
}

async function relayApi(path, options = {}) {
  const credentials = relayCredentials();
  if (!hasRelayCredentials()) {
    throw new Error("Celular ainda não pareado.");
  }

  const response = await fetch(
    `${credentials.relayUrl.replace(/\/$/, "")}${path}`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-radar-mobile-id": credentials.mobileId,
        "x-radar-mobile-key": credentials.mobileKey,
        ...(options.headers || {}),
      },
      ...options,
    },
  );

  return parseResponse(response);
}

function setConnection(online, message, description) {
  state.online = online;
  const pill = $("#connectionPill");
  pill.classList.toggle("online", online);
  pill.classList.toggle("offline", !online);
  $("#connectionText").textContent =
    message ||
    (online ? "Desktop online" : "Desktop offline");

  if (description) {
    $("#heroText").textContent = description;
    return;
  }

  $("#heroText").textContent = online
    ? "Sincronizado com o Radar Desktop. Seus achados estão prontos para triagem."
    : "O Desktop está offline. O último snapshot continua disponível no celular.";
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2400);
}

function money(value, currency = "BRL") {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "Preço —";
  }

  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: currency || "BRL",
    }).format(Number(value));
  } catch {
    return `${currency || "BRL"} ${value}`;
  }
}

function loadCachedSnapshot() {
  try {
    const raw = localStorage.getItem(
      STORAGE.cachedSnapshot,
    );
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveCachedSnapshot(snapshot) {
  try {
    localStorage.setItem(
      STORAGE.cachedSnapshot,
      JSON.stringify(snapshot),
    );
  } catch {
    // Cache é apenas conveniência.
  }
}

function applySnapshot(snapshot) {
  const safe =
    snapshot && typeof snapshot === "object"
      ? snapshot
      : {};

  state.radars = Array.isArray(safe.radars)
    ? safe.radars
    : [];
  state.listings = Array.isArray(safe.listings)
    ? safe.listings
    : [];
  state.activity = Array.isArray(safe.activity)
    ? safe.activity
    : [];
  state.visualReferences = Array.isArray(
    safe.visual_references,
  )
    ? safe.visual_references
    : [];
  state.snapshotSyncedAt =
    safe.synced_at ||
    safe.relay_updated_at ||
    null;
}

function renderStats() {
  $("#statRadars").textContent = state.radars.length;
  $("#statListings").textContent =
    state.listings.length;
  $("#statInteresting").textContent =
    state.listings.filter(
      (item) => item.status === "interessante",
    ).length;
  $("#statNew").textContent =
    state.listings.filter(
      (item) => item.status === "novo",
    ).length;
}

async function queueRelayCommand(type, commandPayload) {
  return relayApi(
    "/bridge/mobile/device/commands",
    {
      method: "POST",
      body: JSON.stringify({
        type,
        payload: commandPayload,
      }),
    },
  );
}

function base64UrlToUint8Array(value) {
  const padding = "=".repeat(
    (4 - (value.length % 4)) % 4,
  );
  const base64 = (value + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(
    [...raw].map((char) => char.charCodeAt(0)),
  );
}

function pushSupported() {
  return Boolean(
    "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window,
  );
}

async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const registration =
    await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function loadNotificationPreferences() {
  const box = $("#notificationPrefs");
  if (!box || state.mode !== "relay") return;

  try {
    const prefs = await relayApi(
      "/bridge/mobile/device/notification-preferences",
    );

    $("#notifyGrailsToggle").checked =
      prefs.notify_grails !== false;
    $("#notifyPriceDropsToggle").checked =
      prefs.notify_price_drops !== false;

    box.hidden = false;
  } catch {
    box.hidden = true;
  }
}

async function saveNotificationPreferences() {
  if (state.mode !== "relay") return;

  const grails = Boolean(
    $("#notifyGrailsToggle")?.checked,
  );
  const priceDrops = Boolean(
    $("#notifyPriceDropsToggle")?.checked,
  );

  await relayApi(
    "/bridge/mobile/device/notification-preferences",
    {
      method: "PUT",
      body: JSON.stringify({
        notify_grails: grails,
        notify_price_drops: priceDrops,
      }),
    },
  );
}

async function updateNotificationUi() {
  const button = $("#notificationButton");
  const label = $("#notificationStatus");
  if (!button || !label) return;

  if (state.mode !== "relay") {
    button.disabled = true;
    label.textContent = "Disponível no Relay";
    return;
  }

  if (!pushSupported()) {
    button.disabled = true;
    label.textContent = "Não suportado neste navegador";
    button.textContent = "Notificações indisponíveis";
    return;
  }

  if (Notification.permission === "denied") {
    button.disabled = true;
    label.textContent = "Bloqueadas pelo navegador";
    button.textContent = "Permissão bloqueada";
    return;
  }

  try {
    const subscription =
      await currentPushSubscription();
    const active = Boolean(subscription);

    button.disabled = false;
    button.classList.toggle("active", active);
    button.textContent = active
      ? "Desativar notificações"
      : "Ativar notificações";
    label.textContent = active
      ? "Ativas"
      : Notification.permission === "granted"
        ? "Desativadas"
        : "Permissão pendente";

    if (active) {
      await loadNotificationPreferences();
    } else {
      const box = $("#notificationPrefs");
      if (box) box.hidden = true;
    }
  } catch {
    button.disabled = false;
    label.textContent = "Não foi possível verificar";
  }
}

async function enablePushNotifications() {
  if (!pushSupported()) {
    throw new Error(
      "Este navegador não oferece notificações push.",
    );
  }

  let permission = Notification.permission;
  if (permission === "default") {
    permission =
      await Notification.requestPermission();
  }

  if (permission !== "granted") {
    throw new Error(
      "Permissão de notificações não concedida.",
    );
  }

  const registration =
    await navigator.serviceWorker.ready;
  let subscription =
    await registration.pushManager.getSubscription();

  if (!subscription) {
    const keys = await relayApi(
      "/bridge/mobile/device/push-key",
    );

    subscription =
      await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey:
          base64UrlToUint8Array(
            keys.public_key,
          ),
      });
  }

  await relayApi(
    "/bridge/mobile/device/push-subscription",
    {
      method: "POST",
      body: JSON.stringify({
        subscription:
          subscription.toJSON(),
      }),
    },
  );

  const test = await relayApi(
    "/bridge/mobile/device/push-test",
    {
      method: "POST",
      body: "{}",
    },
  );

  if (!Number(test.delivered || 0)) {
    throw new Error(
      "A inscrição foi salva, mas o push de teste não foi entregue.",
    );
  }

  return subscription;
}

async function disablePushNotifications() {
  const subscription =
    await currentPushSubscription();

  if (!subscription) return;

  await relayApi(
    "/bridge/mobile/device/push-subscription",
    {
      method: "DELETE",
      body: JSON.stringify({
        endpoint: subscription.endpoint,
      }),
    },
  ).catch(() => {});

  await subscription.unsubscribe();
}

function renderConnectionPanels() {
  const relay = state.mode === "relay";
  $("#relayPanel").hidden = !relay;
  $("#pairByLinkPanel").hidden = relay;
  $("#localPanel").hidden = relay;

  if (relay) {
    $("#pairedDesktopLabel").textContent =
      state.relayStatus?.desktop_label ||
      "Radar Desktop";
  }

  updateNotificationUi().catch(() => {});
}

function visualRadarName(radarId) {
  return (
    state.radars.find(
      (radar) => Number(radar.id) === Number(radarId),
    )?.name || "Radar"
  );
}

function dataUrlBytes(dataUrl) {
  const encoded = String(dataUrl || "").split(",")[1] || "";
  const padding = (encoded.match(/=*$/)?.[0] || "").length;
  return Math.max(
    0,
    Math.floor((encoded.length * 3) / 4) - padding,
  );
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      resolve({ image, url });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new Error(
          "Não consegui abrir essa imagem. Tente JPG ou PNG.",
        ),
      );
    };
    image.src = url;
  });
}

function renderCanvasDataUrl(
  image,
  maxDimension,
  quality,
) {
  const sourceWidth =
    image.naturalWidth || image.width;
  const sourceHeight =
    image.naturalHeight || image.height;

  if (!sourceWidth || !sourceHeight) {
    throw new Error("Imagem sem dimensões válidas.");
  }

  const scale = Math.min(
    1,
    maxDimension /
      Math.max(sourceWidth, sourceHeight),
  );
  const width = Math.max(
    1,
    Math.round(sourceWidth * scale),
  );
  const height = Math.max(
    1,
    Math.round(sourceHeight * scale),
  );

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", {
    alpha: false,
  });
  if (!context) {
    throw new Error(
      "O navegador não conseguiu preparar a imagem.",
    );
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(
    image,
    0,
    0,
    width,
    height,
  );

  return {
    dataUrl: canvas.toDataURL(
      "image/jpeg",
      quality,
    ),
    width,
    height,
  };
}

async function compressVisualFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    throw new Error("Escolha uma imagem válida.");
  }

  if (file.size > 20 * 1024 * 1024) {
    throw new Error(
      "A imagem original é grande demais. Use uma foto de até 20 MB.",
    );
  }

  const loaded = await loadImageFile(file);
  try {
    let dimension = 1100;
    let quality = 0.82;
    let main = renderCanvasDataUrl(
      loaded.image,
      dimension,
      quality,
    );

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (dataUrlBytes(main.dataUrl) <= 420 * 1024) {
        break;
      }

      if (quality > 0.58) {
        quality -= 0.08;
      } else {
        dimension = Math.max(
          620,
          Math.round(dimension * 0.82),
        );
      }

      main = renderCanvasDataUrl(
        loaded.image,
        dimension,
        quality,
      );
    }

    const bytes = dataUrlBytes(main.dataUrl);
    if (bytes > 480 * 1024) {
      throw new Error(
        "Não consegui comprimir essa imagem o suficiente. Tente outra foto.",
      );
    }

    const thumb = renderCanvasDataUrl(
      loaded.image,
      160,
      0.62,
    );

    return {
      fileName: file.name || "referencia.jpg",
      mime_type: "image/jpeg",
      image_base64:
        main.dataUrl.split(",")[1] || "",
      thumbnail_data_url: thumb.dataUrl,
      preview_data_url: main.dataUrl,
      width: main.width,
      height: main.height,
      bytes,
    };
  } finally {
    URL.revokeObjectURL(loaded.url);
  }
}

function clearVisualSelection() {
  state.pendingVisual = null;
  const input = $("#visualImageInput");
  if (input) input.value = "";
  $("#visualPreview").hidden = true;
  $("#visualPreviewImage").removeAttribute("src");
  $("#visualReferenceButton").disabled = true;
}

function renderVisualReferences() {
  const host = $("#visualReferenceList");
  if (!host) return;

  const refs = state.visualReferences
    .slice()
    .sort((left, right) => {
      if (Boolean(left.is_primary) !== Boolean(right.is_primary)) {
        return left.is_primary ? -1 : 1;
      }
      return Number(right.id || 0) - Number(left.id || 0);
    })
    .slice(0, 8);

  host.innerHTML = "";

  if (!refs.length) {
    host.innerHTML =
      '<div class="empty">Nenhuma referência visual sincronizada ainda.</div>';
    return;
  }

  for (const reference of refs) {
    const card = document.createElement("article");
    card.className = "visual-ref";

    if (reference.thumbnail_data_url) {
      const image = document.createElement("img");
      image.src = reference.thumbnail_data_url;
      image.alt =
        reference.label || "Referência visual";
      card.appendChild(image);
    } else {
      const placeholder =
        document.createElement("div");
      placeholder.className =
        "visual-placeholder";
      placeholder.textContent =
        "Referência sem miniatura";
      card.appendChild(placeholder);
    }

    if (reference.is_primary) {
      const badge =
        document.createElement("span");
      badge.className = "visual-primary";
      badge.textContent = "PRINCIPAL";
      card.appendChild(badge);
    } else if (reference.is_enabled !== false) {
      const badge =
        document.createElement("span");
      badge.className = "visual-primary";
      badge.textContent = "ATIVA";
      card.appendChild(badge);
    }

    const info = document.createElement("div");
    info.className = "visual-ref-info";

    const title = document.createElement("strong");
    title.textContent =
      reference.label || "Referência visual";

    const meta = document.createElement("small");
    meta.textContent = visualRadarName(
      reference.radar_id,
    );

    info.append(title, meta);
    card.appendChild(info);
    host.appendChild(card);
  }
}

function renderImportRadars() {
  const fill = (
    select,
    placeholder,
    allowEmpty,
  ) => {
    if (!select) return;

    const current = select.value;
    select.innerHTML = "";

    const first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    if (!allowEmpty) first.disabled = true;
    select.appendChild(first);

    for (const radar of state.radars) {
      const option = document.createElement("option");
      option.value = String(radar.id);
      option.textContent = radar.name;
      select.appendChild(option);
    }

    if (
      current &&
      [...select.options].some(
        (option) => option.value === current,
      )
    ) {
      select.value = current;
    }
  };

  fill(
    $("#importRadarSelect"),
    "Sem radar",
    true,
  );
  fill(
    $("#visualRadarSelect"),
    "Escolha um radar",
    false,
  );
}

function renderRadars() {
  const host = $("#radarsList");
  host.innerHTML = "";

  if (!state.radars.length) {
    host.innerHTML =
      '<div class="empty">Nenhum radar encontrado.</div>';
    return;
  }

  for (const radar of state.radars) {
    const node = $("#radarTemplate").content
      .firstElementChild.cloneNode(true);

    node.querySelector(
      ".radar-category",
    ).textContent = radar.category || "geral";
    node.querySelector(".radar-name").textContent =
      radar.name;
    node.querySelector(".radar-query").textContent =
      radar.query || "Sem termos configurados";
    node.querySelector(".radar-count").textContent =
      radar.listing_count ?? 0;
    node.querySelector(
      ".radar-schedule",
    ).textContent = radar.schedule_enabled
      ? `Ativo • a cada ${Math.round(
          (radar.schedule_interval_minutes || 240) /
            60,
        )}h`
      : "Agendamento desligado";

    const button = node.querySelector(".run-button");
    button.addEventListener("click", async () => {
      button.disabled = true;
      const before = button.textContent;
      button.textContent =
        state.mode === "relay"
          ? "Enviando…"
          : "Rodando…";

      try {
        if (state.mode === "relay") {
          await queueRelayCommand("run_radar", {
            radar_id: radar.id,
          });
          toast(
            state.online
              ? "Comando enviado ao Desktop."
              : "Desktop offline. Comando ficou na fila.",
          );
        } else {
          await api(`/api/radars/${radar.id}/run`, {
            method: "POST",
            body: "{}",
          });
          toast("Radar executado.");
          await refresh();
        }
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
  const visibleListings = state.listings
    .filter(
      (item) => !item.rule_rejected,
    )
    .slice()
    .sort((a, b) => {
      const score = (item) =>
        Number(
          item.ranking_score ??
            item.grail_score ??
            item.hybrid_score ??
            item.rule_score ??
            0,
        ) || 0;
      return score(b) - score(a);
    });
  const listings = filter
    ? visibleListings.filter(
        (item) => item.status === filter,
      )
    : visibleListings;

  host.innerHTML = "";

  if (!listings.length) {
    host.innerHTML =
      '<div class="empty">Nenhum anúncio nesse filtro.</div>';
    return;
  }

  for (const listing of listings.slice(0, 60)) {
    const node = $("#listingTemplate").content
      .firstElementChild.cloneNode(true);
    const link = node.querySelector(".listing-link");

    link.href = listing.url || "#";

    const img = node.querySelector(".listing-image");
    if (listing.image_url) {
      img.src = listing.image_url;
    }
    img.alt = listing.title || "Anúncio";

    node.querySelector(
      ".listing-platform",
    ).textContent = listing.platform || "Radar";
    node.querySelector(".listing-title").textContent =
      listing.title || "Sem título";
    node.querySelector(".listing-price").textContent =
      money(
        listing.current_price,
        listing.currency,
      );

    const score =
      listing.ranking_score ??
      listing.grail_score ??
      listing.hybrid_score ??
      listing.rule_score;

    node.querySelector(
      ".listing-score",
    ).textContent =
      score === null || score === undefined
        ? ""
        : `Rank ${Math.round(score)}`;

    const visualChip =
      node.querySelector(".visual-chip");
    const semanticChip =
      node.querySelector(".semantic-chip");
    const grailChip =
      node.querySelector(".grail-chip");

    visualChip.textContent =
      listing.visual_score === null ||
      listing.visual_score === undefined
        ? ""
        : `Visual ${Math.round(listing.visual_score)}`;
    semanticChip.textContent =
      listing.semantic_score === null ||
      listing.semantic_score === undefined
        ? ""
        : `Semântico ${Math.round(listing.semantic_score)}`;
    grailChip.textContent =
      listing.grail_score === null ||
      listing.grail_score === undefined
        ? ""
        : `Grail ${Math.round(listing.grail_score)}`;

    const updateStatus = async (status) => {
      try {
        if (state.mode === "relay") {
          await queueRelayCommand(
            "update_listing_status",
            {
              listing_id: listing.id,
              status,
            },
          );

          listing.status = status;
          renderListings();
          renderStats();

          toast(
            state.online
              ? "Alteração enviada ao Desktop."
              : "Alteração salva na fila.",
          );
          return;
        }

        await api(`/api/listings/${listing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status }),
        });

        listing.status = status;
        renderListings();
        renderStats();

        toast(
          status === "interessante"
            ? "Guardado como interessante."
            : "Anúncio descartado.",
        );
      } catch (error) {
        toast(error.message);
      }
    };

    node
      .querySelector(".interesting")
      .addEventListener("click", () =>
        updateStatus("interessante"),
      );
    node
      .querySelector(".discard")
      .addEventListener("click", () =>
        updateStatus("descartado"),
      );

    host.appendChild(node);
  }
}

async function refreshLocal() {
  try {
    await api("/api/health");

    const [radars, listings, visualReferences] =
      await Promise.all([
        api("/api/radars"),
        api("/api/listings"),
        api("/api/visual-references").catch(
          () => [],
        ),
      ]);

    state.radars = Array.isArray(radars)
      ? radars
      : [];
    state.listings = Array.isArray(listings)
      ? listings
      : [];
    state.activity = [];
    state.visualReferences =
      Array.isArray(visualReferences)
        ? visualReferences
        : [];

    setConnection(
      true,
      "Desktop online",
      "Conectado diretamente ao Radar pela rede local.",
    );
  } catch {
    setConnection(
      false,
      "Desktop offline",
      "Sem conexão local com o Radar Desktop.",
    );

    if (!state.radars.length) {
      $("#radarsList").innerHTML =
        '<div class="empty">Conecte ao Radar Desktop para carregar seus radares.</div>';
    }

    if (!state.listings.length) {
      $("#listingsList").innerHTML =
        '<div class="empty">Sem conexão com o Radar.</div>';
    }
  }
}

async function refreshRelay() {
  let status = null;
  let snapshot = null;

  try {
    status = await relayApi(
      "/bridge/mobile/device/status",
    );
    state.relayStatus = status;
  } catch (error) {
    if (error.status === 401) {
      toast(
        "O pareamento não é mais válido. Reconecte este celular.",
      );
    }
  }

  try {
    snapshot = await relayApi(
      "/bridge/mobile/device/snapshot",
    );
    saveCachedSnapshot(snapshot);
  } catch {
    snapshot = loadCachedSnapshot();
  }

  if (snapshot) {
    applySnapshot(snapshot);
  }

  const online = Boolean(status?.online);
  const synced = state.snapshotSyncedAt
    ? new Date(
        state.snapshotSyncedAt,
      ).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  setConnection(
    online,
    online
      ? "Desktop online"
      : "Desktop offline • Relay",
    online
      ? `Relay conectado. Último snapshot ${
          synced ? `em ${synced}` : "sincronizado"
        }.`
      : `O notebook está offline. ${
          synced
            ? `Mostrando o snapshot de ${synced}.`
            : "Aguardando o primeiro snapshot."
        } Comandos novos ficam na fila.`,
  );
}

async function refresh() {
  state.mode = hasRelayCredentials()
    ? "relay"
    : "local";

  renderConnectionPanels();

  if (state.mode === "relay") {
    await refreshRelay();
  } else {
    await refreshLocal();
  }

  renderConnectionPanels();
  renderStats();
  renderImportRadars();
  renderVisualReferences();
  renderRadars();
  renderListings();
}

$("#visualImageInput").addEventListener(
  "change",
  async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      clearVisualSelection();
      return;
    }

    const button = $("#visualReferenceButton");
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Preparando imagem…";

    try {
      const prepared =
        await compressVisualFile(file);
      state.pendingVisual = prepared;

      $("#visualPreviewImage").src =
        prepared.preview_data_url;
      $("#visualPreviewName").textContent =
        prepared.fileName;
      $("#visualPreviewMeta").textContent =
        `${prepared.width}×${prepared.height} • ${Math.max(
          1,
          Math.round(prepared.bytes / 1024),
        )} KB após compressão`;
      $("#visualPreview").hidden = false;

      button.disabled =
        !$("#visualRadarSelect").value;
      toast("Imagem pronta para enviar.");
    } catch (error) {
      clearVisualSelection();
      toast(error.message);
    } finally {
      button.textContent = original;
    }
  },
);

$("#visualRadarSelect").addEventListener(
  "change",
  () => {
    $("#visualReferenceButton").disabled =
      !state.pendingVisual ||
      !$("#visualRadarSelect").value;
  },
);

$("#visualReferenceButton").addEventListener(
  "click",
  async () => {
    const radarId = Number(
      $("#visualRadarSelect").value,
    );
    const prepared = state.pendingVisual;
    const button = $("#visualReferenceButton");

    if (
      !Number.isInteger(radarId) ||
      radarId <= 0
    ) {
      toast("Escolha o radar que vai usar essa imagem.");
      return;
    }

    if (!prepared) {
      toast("Escolha uma imagem primeiro.");
      return;
    }

    const payload = {
      radar_id: radarId,
      label:
        $("#visualLabelInput").value.trim(),
      mime_type: prepared.mime_type,
      image_base64: prepared.image_base64,
      thumbnail_data_url:
        prepared.thumbnail_data_url,
    };

    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Enviando referência…";

    try {
      if (state.mode === "relay") {
        await queueRelayCommand(
          "import_visual_reference",
          payload,
        );

        toast(
          state.online
            ? "Imagem enviada. O Desktop vai ativar a referência."
            : "Notebook offline. A imagem ficou na fila.",
        );

        if (state.online) {
          setTimeout(() => {
            refresh().catch(() => {});
          }, 3500);
        }
      } else {
        await api(
          "/api/mobile/import-visual-reference",
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );
        toast(
          "Referência visual ativada no Radar.",
        );
        await refresh();
      }

      $("#visualLabelInput").value = "";
      clearVisualSelection();
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    } finally {
      button.textContent = original;
    }
  },
);

$("#importUrlButton").addEventListener(
  "click",
  async () => {
    const input = $("#importUrlInput");
    const button = $("#importUrlButton");
    const rawUrl = input.value.trim();
    const radarValue = $("#importRadarSelect").value;
    const radarId = radarValue
      ? Number(radarValue)
      : null;

    try {
      const parsed = new URL(rawUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Use um link http:// ou https://");
      }
    } catch {
      toast("Cole um link válido.");
      return;
    }

    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Adicionando…";

    try {
      if (state.mode === "relay") {
        await queueRelayCommand("import_url", {
          url: rawUrl,
          radar_id: radarId,
        });

        toast(
          state.online
            ? "Link enviado ao Desktop."
            : "Notebook offline. Link ficou na fila.",
        );
      } else {
        const result = await api(
          "/api/mobile/import-url",
          {
            method: "POST",
            body: JSON.stringify({
              url: rawUrl,
              radar_id: radarId,
            }),
          },
        );

        toast(
          result.duplicate
            ? "Esse link já estava salvo."
            : "Link adicionado ao Radar.",
        );
        await refresh();
      }

      input.value = "";
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  },
);

$("#refreshButton").addEventListener(
  "click",
  refresh,
);

$("#statusFilter").addEventListener(
  "change",
  renderListings,
);

$("#pairByLinkButton")?.addEventListener("click", () => {
  const typed = $("#pairLinkInput").value.trim();
  let link;
  try {
    link = new URL(typed);
  } catch {
    toast("Cole o link completo gerado pelo QR.");
    return;
  }
  if (link.protocol !== "https:" ||
      link.hostname !== "radar-2-0-littleghoost.fly.dev" ||
      link.pathname !== "/mobile/pair.html" ||
      link.username || link.password || link.port) {
    toast("Use apenas o link seguro do QR do Radar 2.0.");
    return;
  }
  const params = new URLSearchParams(link.hash.replace(/^#/, ""));
  const id = params.get("id") || "";
  const secret = params.get("secret") || "";
  if (!/^[a-fA-F0-9]{32}$/.test(id) ||
      !/^[A-Za-z0-9_-]{24,128}$/.test(secret)) {
    toast("Este link está incompleto ou é inválido. Gere outro QR.");
    return;
  }
  // Stay inside this app's WebView so credentials are saved to its
  // private localStorage, not to the external browser's storage.
  location.assign("./pair.html#" + new URLSearchParams({
    id,
    secret,
  }).toString());
});

$("#baseUrlInput").value = state.baseUrl;

$("#saveConnectionButton").addEventListener(
  "click",
  async () => {
    const value = $("#baseUrlInput")
      .value.trim()
      .replace(/\/$/, "");

    if (!/^https?:\/\//i.test(value)) {
      toast(
        "Use um endereço começando com http:// ou https://",
      );
      return;
    }

    state.baseUrl = value;
    localStorage.setItem(
      STORAGE.baseUrl,
      value,
    );
    localStorage.setItem(
      STORAGE.mode,
      "local",
    );

    toast("Endereço salvo.");
    await refresh();
  },
);

$("#notifyGrailsToggle").addEventListener(
  "change",
  async () => {
    try {
      await saveNotificationPreferences();
      toast("Preferência de grails salva.");
    } catch (error) {
      toast(error.message);
      await loadNotificationPreferences();
    }
  },
);

$("#notifyPriceDropsToggle").addEventListener(
  "change",
  async () => {
    try {
      await saveNotificationPreferences();
      toast("Preferência de preço salva.");
    } catch (error) {
      toast(error.message);
      await loadNotificationPreferences();
    }
  },
);

$("#notificationButton").addEventListener(
  "click",
  async () => {
    const button = $("#notificationButton");
    button.disabled = true;

    try {
      const subscription =
        await currentPushSubscription();

      if (subscription) {
        await disablePushNotifications();
        toast("Notificações desativadas.");
      } else {
        await enablePushNotifications();
        toast(
          "Notificações ativadas. O teste foi enviado.",
        );
      }
    } catch (error) {
      toast(error.message);
    } finally {
      await updateNotificationUi();
    }
  },
);

$("#unlinkButton").addEventListener(
  "click",
  async () => {
    if (
      !confirm(
        "Desvincular este celular do Radar?",
      )
    ) {
      return;
    }

    try {
      if (hasRelayCredentials()) {
        await relayApi(
          "/bridge/mobile/device/revoke",
          {
            method: "POST",
            body: "{}",
          },
        );
      }
    } catch {
      // Limpeza local continua mesmo se o relay estiver indisponível.
    }

    for (const key of [
      STORAGE.mode,
      STORAGE.relayUrl,
      STORAGE.mobileId,
      STORAGE.mobileKey,
      STORAGE.desktopId,
      STORAGE.cachedSnapshot,
    ]) {
      localStorage.removeItem(key);
    }

    state.mode = "local";
    state.radars = [];
    state.listings = [];
    state.activity = [];
    state.visualReferences = [];
    state.pendingVisual = null;
    state.relayStatus = null;

    toast("Celular desvinculado.");
    await refresh();
  },
);

document
  .querySelectorAll(".nav-item")
  .forEach((button) => {
    button.addEventListener("click", () => {
      document
        .querySelectorAll(".nav-item")
        .forEach((item) =>
          item.classList.remove("active"),
        );

      button.classList.add("active");

      const target = button.dataset.target;
      if (target === "top") {
        scrollTo({
          top: 0,
          behavior: "smooth",
        });
      } else {
        document
          .getElementById(target)
          ?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
      }
    });
  });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .catch(() => {});
}

refresh();

setInterval(() => {
  if (document.visibilityState === "visible") {
    refresh();
  }
}, state.mode === "relay" ? 30000 : 60000);
