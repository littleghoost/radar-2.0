const fs = require("fs");

function resolveStoredFilePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return raw;

  if (process.platform === "win32") {
    const wslPath = raw.match(
      /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/,
    );

    if (wslPath) {
      const drive = wslPath[1].toUpperCase();
      const rest = String(
        wslPath[2] || "",
      ).replace(/\//g, "\\");
      return `${drive}:\\${rest}`;
    }
  } else {
    const windowsPath = raw.match(
      /^([a-zA-Z]):[\\/](.*)$/,
    );

    if (
      windowsPath &&
      fs.existsSync("/mnt")
    ) {
      const drive = windowsPath[1].toLowerCase();
      const rest = String(
        windowsPath[2] || "",
      ).replace(/\\/g, "/");
      return `/mnt/${drive}/${rest}`;
    }
  }

  return raw;
}

module.exports = {
  resolveStoredFilePath,
};
