"use strict";

const RELEASES_API = "https://api.github.com/repos/littleghoost/radar-2.0/releases/latest";
const OFFICIAL_DOWNLOAD_PREFIX =
  "https://github.com/littleghoost/radar-2.0/releases/download/";
const CACHE_MS = 15 * 60 * 1000;
let releaseCache = null;
let cachedAt = 0;

function parseStableVersion(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(raw || "").trim());
  return match ? match.slice(1).map(Number) : null;
}

function compareStableVersions(first, second) {
  const a = parseStableVersion(first);
  const b = parseStableVersion(second);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function parseOfficialRelease(release) {
  if (!release || release.draft || release.prerelease) return null;
  if (!parseStableVersion(release.tag_name)) return null;
  const tag = String(release.tag_name);
  const trustedPrefix = OFFICIAL_DOWNLOAD_PREFIX + encodeURIComponent(tag) + "/";
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const windowsInstaller = assets.find((asset) => {
    const name = String(asset?.name || "");
    const url = String(asset?.browser_download_url || "");
    return /\.(exe)$/i.test(name) &&
      /^[\w .()+-]{1,180}\.exe$/i.test(name) &&
      url.startsWith(trustedPrefix) &&
      url === trustedPrefix + encodeURIComponent(name) &&
      Number(asset?.size) > 100_000;
  });

  // Only show an update when the official Windows installer is available.
  if (!windowsInstaller) return null;
  const releaseUrl = String(release.html_url || "");
  if (releaseUrl !==
      "https://github.com/littleghoost/radar-2.0/releases/tag/" + encodeURIComponent(tag)) {
    return null;
  }

  return {
    version: tag.replace(/^v/, ""),
    tag,
    notes: String(release.body || "").slice(0, 3500),
    published_at: release.published_at || null,
    release_url: releaseUrl,
    download_url: windowsInstaller.browser_download_url,
    installer_name: String(windowsInstaller.name),
    installer_size_bytes: Number(windowsInstaller.size),
  };
}

async function getLatestOfficialRelease() {
  if (releaseCache && Date.now() - cachedAt < CACHE_MS) return releaseCache;
  const response = await fetch(RELEASES_API, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "Radar-2.0-Desktop-Update-Checker",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error("GitHub não respondeu à verificação de atualizações.");
  }

  const release = parseOfficialRelease(await response.json());
  if (!release) {
    throw new Error("Não encontrei uma versão Windows oficial válida.");
  }

  releaseCache = release;
  cachedAt = Date.now();
  return release;
}

async function checkDesktopUpdate(installedVersion) {
  if (!parseStableVersion(installedVersion)) {
    throw new Error("Versão instalada não identificada.");
  }
  const latest = await getLatestOfficialRelease();
  if (!latest) {
    return {
      supported: true,
      installed_version: installedVersion,
      update_available: false,
      message: "Ainda não há versões oficiais publicadas.",
      latest: null,
    };
  }
  return {
    supported: true,
    installed_version: installedVersion,
    update_available: compareStableVersions(latest.version, installedVersion) > 0,
    message: null,
    latest,
  };
}

module.exports = {
  parseStableVersion,
  compareStableVersions,
  parseOfficialRelease,
  checkDesktopUpdate,
};
