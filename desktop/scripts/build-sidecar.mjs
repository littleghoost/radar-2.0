import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const project = resolve(desktop, "..");
const triple = execSync("rustc --print host-tuple", { encoding: "utf8" }).trim();
const ext = process.platform === "win32" ? ".exe" : "";
const outDir = resolve(desktop, "src-tauri/binaries");
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, `radar-backend-${triple}${ext}`);
const pkgBin = resolve(desktop, "node_modules/@yao-pkg/pkg/lib-es5/bin.js");
if (!existsSync(pkgBin)) throw new Error("@yao-pkg/pkg não encontrado. Rode npm install em desktop/.");
const args = [
  pkgBin,
  "server/app.js",
  "--target",
  process.platform === "win32" ? "node22-win-x64" : "node22-linux-x64",
  "--output",
  out,
  "--config",
  "desktop/sidecar.pkg.json",
];
console.log(`Empacotando backend -> ${out}`);
execFileSync(process.execPath, args, { cwd: project, stdio: "inherit" });
