#!/usr/bin/env node
// make-exe.mjs  --  drop into any web app folder, run `node make-exe.mjs`, get a distributable Windows .exe.
//
// Discovers: frontend (Angular/Vite/CRA/Vue/Parcel/plain HTML), backend (Express/Fastify/Koa/Hono/http/Bun.serve),
//            database (better-sqlite3 -> bun:sqlite shim, *.db files), assets and icons.
// Generates: .exe-build/entry.ts (+ shim, tsconfig), compiles with Bun, assembles release/<Name>/, optionally runs it.
//
// Flags: --name=X  --out=release  --port=3000  --icon=app.ico  --console  --no-minify
//        --skip-frontend-build  --no-run  --zip  --keep  --dry
// Needs: Node 18+ (to run this script). Bun is auto-installed if missing.

import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { builtinModules } from "module";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const opt = (n) => { const a = argv.find((x) => x.startsWith("--" + n + "=")); return a ? a.slice(n.length + 3) : undefined; };
const isWin = process.platform === "win32";

const log = (m) => console.log("\x1b[36m[make-exe]\x1b[0m " + m);
const warn = (m) => console.log("\x1b[33m[warn]\x1b[0m " + m);
const die = (m) => { console.error("\x1b[31m[error]\x1b[0m " + m); process.exit(1); };

const exists = (p) => fs.existsSync(p);
const isFile = (p) => exists(p) && fs.statSync(p).isFile();
const isDir = (p) => exists(p) && fs.statSync(p).isDirectory();
const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const readJson = (p) => { try { return JSON.parse(readText(p)); } catch { return null; } };
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/") || ".";

const OUT_NAME = opt("out") || "release";
const IGNORE = new Set(["node_modules", ".git", ".exe-build", OUT_NAME, "dist", "build", ".angular", ".vscode", ".idea", "coverage", ".next", ".cache"]);

function walk(dir, depth = 3, ignore = IGNORE, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (ignore.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) walk(p, depth - 1, ignore, out); } else out.push(p);
  }
  return out;
}

function run(cmd, args, cwd = ROOT, shell = false) {
  log("$ " + cmd + " " + args.join(" "));
  if (flag("dry")) return 0;
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell });
  return r.status ?? 1;
}

// ------------------------------------------------------------------ discovery
const pkg = readJson(path.join(ROOT, "package.json")) || {};
const allDeps = (p) => ({ ...(p?.dependencies || {}), ...(p?.devDependencies || {}) });
const deps = allDeps(pkg);

const appName = (opt("name") || pkg.name || path.basename(ROOT)).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "App";
const hash = [...appName].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function detectFrontend() {
  const bases = [ROOT, ...["frontend", "client", "web", "ui", "app"].map((d) => path.join(ROOT, d))].filter(isDir);
  for (const dir of bases) {
    const p = readJson(path.join(dir, "package.json"));
    const d = allDeps(p);
    let kind = null;
    if (isFile(path.join(dir, "angular.json"))) kind = "angular";
    else if (d["vite"]) kind = "vite";
    else if (d["react-scripts"]) kind = "cra";
    else if (d["@vue/cli-service"]) kind = "vuecli";
    else if (d["parcel"]) kind = "parcel";
    else if (d["next"]) kind = "next";
    else if (d["@sveltejs/kit"]) kind = "sveltekit";
    if (kind && p?.scripts?.build) return { dir, kind, pkg: p };
  }
  return null;
}

function findBuiltOutput(baseDir) {
  let best = null;
  for (const d of ["dist", "build", "out", "www", ".output/public"]) {
    const root = path.join(baseDir, d);
    if (!isDir(root)) continue;
    for (const f of walk(root, 4, new Set(["node_modules"]))) {
      if (path.basename(f) === "index.html") {
        const t = fs.statSync(f).mtimeMs;
        if (!best || t > best.t) best = { dir: path.dirname(f), t };
      }
    }
  }
  return best?.dir || null;
}

const BACKEND_RE = /(\.listen\s*\(|Bun\.serve\s*\(|createServer\s*\()/;
const BROWSER_RE = /(document\.|window\.|localStorage)/;
function detectBackend() {
  const bases = [ROOT, ...["backend", "server", "api"].map((d) => path.join(ROOT, d))].filter(isDir);
  const cands = [];
  if (pkg.main) cands.push(path.join(ROOT, pkg.main));
  const startCmd = pkg.scripts?.start || pkg.scripts?.dev || pkg.scripts?.serve || "";
  for (const tok of startCmd.split(/\s+/)) if (/\.(c|m)?[jt]s$/.test(tok)) cands.push(path.join(ROOT, tok));
  const names = ["server", "index", "app", "main"];
  const exts = ["ts", "js", "mjs", "cjs"];
  for (const b of bases) for (const sub of ["", "src", "dist"]) for (const n of names) for (const e of exts) cands.push(path.join(b, sub, n + "." + e));
  for (const c of cands) {
    if (!isFile(c)) continue;
    const code = readText(c);
    if (BACKEND_RE.test(code) && !BROWSER_RE.test(code)) return { file: c, code };
  }
  return null;
}

function detectPort(code) {
  const res = [
    /process\.env\.PORT\s*(?:\|\||\?\?)\s*(\d{2,5})/,
    /(?:const|let|var)\s+PORT\s*=\s*(?:[^;\n]*?(?:\|\||\?\?)\s*)?(\d{2,5})/i,
    /listen\s*\(\s*(\d{2,5})/,
    /port\s*:\s*(\d{2,5})/,
  ];
  for (const r of res) { const m = code.match(r); if (m) return Number(m[1]); }
  return 3000;
}

console.log("");
log("Project: " + appName + "  (" + ROOT + ")");

const frontend = detectFrontend();
const backend = detectBackend();
const usesBetterSqlite = !!deps["better-sqlite3"] || (backend && /better-sqlite3/.test(backend.code));
const otherDb = ["sqlite3", "sql.js", "prisma", "@prisma/client", "mongoose", "pg", "mysql2", "typeorm", "sequelize", "knex"].filter((d) => deps[d]);
const dbFiles = walk(ROOT, 3).filter((f) => /\.(db|sqlite|sqlite3)$/i.test(f));
const assetDirs = ["assets", "images", "img", "fonts", "icons", "media", "static", "uploads"].map((d) => path.join(ROOT, d)).filter(isDir);
const iconFile = opt("icon") ? path.resolve(opt("icon")) : walk(ROOT, 2).find((f) => /\.ico$/i.test(f));

log("Frontend : " + (frontend ? frontend.kind + " in " + rel(frontend.dir) : "none (framework) - looking for static files"));
log("Backend  : " + (backend ? rel(backend.file) : "none"));
log("Database : " + ([usesBetterSqlite ? "better-sqlite3 (-> bun:sqlite shim)" : null, ...otherDb, dbFiles.length ? dbFiles.length + " db file(s)" : null].filter(Boolean).join(", ") || "none"));
log("Assets   : " + (assetDirs.map(rel).join(", ") || "none") + (iconFile ? "  icon: " + rel(iconFile) : ""));
if (otherDb.length) warn("These DB/ORM packages may not work inside a Bun exe: " + otherDb.join(", ") + ". (better-sqlite3 is handled automatically.)");
if (frontend && ["next", "sveltekit"].includes(frontend.kind)) warn(frontend.kind + " needs a static export to work here (server-side rendering is not supported).");

// ------------------------------------------------------------------ bun
function findBun() {
  try { const r = spawnSync("bun", ["--version"], { shell: isWin }); if (r.status === 0) return "bun"; } catch {}
  const p = path.join(os.homedir(), ".bun", "bin", isWin ? "bun.exe" : "bun");
  return isFile(p) ? p : null;
}
let bun = findBun();
if (!bun) {
  log("Bun not found - installing (official installer)...");
  if (!flag("dry")) {
    if (isWin) spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm bun.sh/install.ps1 | iex"], { stdio: "inherit" });
    else spawnSync("sh", ["-c", "curl -fsSL https://bun.sh/install | bash"], { stdio: "inherit" });
    bun = findBun();
    if (!bun) { run("npm", ["install", "-g", "bun"], ROOT, true); bun = findBun(); }
    if (!bun) die("Could not install Bun. Install it manually (https://bun.sh) and re-run.");
  } else bun = "bun";
}

// ------------------------------------------------------------------ dependencies
function bareImports(files) {
  const found = new Set();
  const re = /(?:require\(\s*|from\s+|import\s*\(\s*|import\s+)["']([^"'./][^"']*)["']/g;
  for (const f of files) {
    if (!/\.(c|m)?[jt]sx?$/.test(f)) continue;
    const code = readText(f);
    let m;
    while ((m = re.exec(code))) {
      const spec = m[1];
      if (spec.startsWith("node:") || spec.startsWith("bun:")) continue;
      const parts = spec.split("/");
      const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      if (builtinModules.includes(name) || name === "better-sqlite3") continue;
      found.add(name);
    }
  }
  return [...found];
}

for (const dir of [...new Set([ROOT, frontend?.dir].filter(Boolean))]) {
  const p = readJson(path.join(dir, "package.json"));
  if (!p) continue;
  const nm = path.join(dir, "node_modules");
  const declaredMissing = Object.keys(p.dependencies || {}).filter((d) => !isDir(path.join(nm, d)));
  if (!isDir(nm) || declaredMissing.length) {
    log("Installing dependencies" + (declaredMissing.length ? " (missing: " + declaredMissing.join(", ") + ")" : "") + "...");
    if (run("npm", ["install"], dir, true) !== 0) die("npm install failed in " + dir);
  }
}
if (backend) {
  const backendDir = path.dirname(backend.file);
  const files = walk(backendDir, 4, new Set(["node_modules", ".git", ".exe-build"]));
  const missing = bareImports(files).filter((d) => !isDir(path.join(ROOT, "node_modules", d)) && !isDir(path.join(backendDir, "node_modules", d)));
  if (missing.length) {
    log("Backend imports packages that are not installed: " + missing.join(", "));
    if (run("npm", ["install", "--no-save", ...missing], ROOT, true) !== 0) die("Could not install: " + missing.join(", "));
  }
}

// ------------------------------------------------------------------ frontend build / static files
let staticSrc = null;
let publicRel = "public";
let flatTemp = null;

if (frontend && !flag("skip-frontend-build")) {
  const started = Date.now();
  if (run("npm", ["run", "build"], frontend.dir, true) !== 0) die("Frontend build failed.");
  staticSrc = findBuiltOutput(frontend.dir);
  if (staticSrc && !flag("dry") && fs.statSync(path.join(staticSrc, "index.html")).mtimeMs < started - 5000) warn("Build output looks older than this build run: " + rel(staticSrc));
} else if (frontend) {
  staticSrc = findBuiltOutput(frontend.dir);
}

if (!staticSrc) {
  for (const d of ["public", "www", "static", "web", "client", "frontend"]) {
    if (isFile(path.join(ROOT, d, "index.html"))) { staticSrc = path.join(ROOT, d); publicRel = d; break; }
  }
}
if (!staticSrc && isFile(path.join(ROOT, "index.html"))) {
  flatTemp = path.join(ROOT, ".exe-build", "flat-public");
  fs.rmSync(flatTemp, { recursive: true, force: true });
  fs.mkdirSync(flatTemp, { recursive: true });
  const skip = new Set([backend ? path.basename(backend.file) : ""]);
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!e.isFile() || skip.has(e.name)) continue;
    if (/^(package(-lock)?|tsconfig|bun\.lockb?|vite\.config|eslint|\.)/i.test(e.name) || /\.config\.[cm]?[jt]s$/.test(e.name) || /\.ts$/.test(e.name)) continue;
    if (/\.(html|css|js|mjs|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|txt|map|webmanifest)$/i.test(e.name)) fs.copyFileSync(path.join(ROOT, e.name), path.join(flatTemp, e.name));
  }
  for (const d of assetDirs) fs.cpSync(d, path.join(flatTemp, path.basename(d)), { recursive: true });
  staticSrc = flatTemp;
  log("Flat layout detected: collected web files from project root.");
}
if (!staticSrc && !backend) die("Found neither a frontend (index.html / framework build) nor a backend entry. Nothing to wrap.");
if (staticSrc) log("Static files: " + rel(staticSrc) + "  ->  " + OUT_NAME + "/" + appName + "/" + publicRel);

// ------------------------------------------------------------------ config + generated files
const backendServesStatic = !!backend && /(express\.static|serveStatic|sendFile|@fastify\/static|ServeStatic|Bun\.file)/.test(backend.code);
const backendPort = opt("port") ? Number(opt("port")) : backend ? detectPort(backend.code) : 0;
const serveStatic = !!staticSrc && !backendServesStatic;
const lifePort = 40000 + (hash % 20000);

const cfg = {
  name: appName,
  lifePort,
  publicRel,
  serveStatic,
  backendPort,
  hasBackend: !!backend,
  proxyPrefixes: ["/api"],
  windowSize: "1280,860",
};
log("Mode: " + (backend ? (serveStatic ? "frontend + proxied backend (/api -> :" + backendPort + ")" : "backend serves its own files (port " + backendPort + ")") : "static site"));

const BUILD_DIR = path.join(ROOT, ".exe-build");
fs.mkdirSync(path.join(BUILD_DIR, "shims"), { recursive: true });

let backendImportPath = backend ? rel(backend.file) : "";
if (backend && path.dirname(backend.file) !== ROOT) {
  const bdir = path.dirname(backend.file);
  const bfiles = walk(bdir, 8, new Set(["node_modules", ".git", ".exe-build"]));
  const isCode = (f) => /\.(c|m)?[jt]s$/.test(f);
  if (bfiles.some((f) => isCode(f) && /__dirname|__filename/.test(readText(f)))) {
    const copyDir = path.join(BUILD_DIR, "backend");
    fs.rmSync(copyDir, { recursive: true, force: true });
    for (const f of bfiles) {
      const dest = path.join(copyDir, path.relative(bdir, f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (isCode(f)) {
        let code = readText(f);
        if (/__dirname|__filename/.test(code) && !/(?:const|let|var)\s+__(?:dirname|filename)\b/.test(code)) {
          const pro = "var __dirname = process.cwd() + " + JSON.stringify("/" + rel(path.dirname(f))) +
            ", __filename = process.cwd() + " + JSON.stringify("/" + rel(f)) + ";\n";
          const m = code.match(/^\s*["']use strict["'];?[ \t]*\r?\n?/);
          code = m ? m[0] + pro + code.slice(m[0].length) : pro + code;
        }
        fs.writeFileSync(dest, code);
      } else fs.copyFileSync(f, dest);
    }
    backendImportPath = rel(path.join(copyDir, path.basename(backend.file)));
    log("Rewrote __dirname/__filename in " + rel(bdir) + " to be exe-relative.");
  }
}

const entryTemplate = String.raw`import path from "path";
import fs from "fs";
import { spawn } from "child_process";

const CFG: any = __CFG__;
const exeDir = path.dirname(process.execPath);
process.chdir(exeDir);
const dataDir = path.join(exeDir, "data");
fs.mkdirSync(dataDir, { recursive: true });
const publicDir = path.join(exeDir, CFG.publicRel);

const log = (...a: unknown[]) => { try { fs.appendFileSync(path.join(dataDir, "app.log"), new Date().toISOString() + " " + a.join(" ") + "\n"); } catch {} };
process.on("uncaughtException", (e: any) => { log("uncaught", e?.stack || e); });
process.on("unhandledRejection", (e) => log("rejection", String(e)));

let quitTimer: any = null;
const cancelQuit = () => { if (quitTimer) { clearTimeout(quitTimer); quitTimer = null; } };
const scheduleQuit = () => { if (!quitTimer) quitTimer = setTimeout(() => { log("quit"); process.exit(0); }, 3000); };
const cors = { "access-control-allow-origin": "*", "x-app": CFG.name };

async function serveStatic(pathname: string): Promise<Response> {
  let r = decodeURIComponent(pathname);
  if (r === "/" || r === "") r = "/index.html";
  const full = path.normalize(path.join(publicDir, r));
  if (!full.startsWith(publicDir)) return new Response("Forbidden", { status: 403 });
  if (fs.existsSync(full) && fs.statSync(full).isFile()) return new Response(Bun.file(full));
  if (!path.extname(r)) {
    const idx = path.join(publicDir, "index.html");
    if (fs.existsSync(idx)) return new Response(Bun.file(idx));
  }
  return new Response("Not found", { status: 404 });
}

async function proxy(req: Request, url: URL): Promise<Response> {
  try {
    const h = new Headers(req.headers);
    h.delete("host");
    h.set("accept-encoding", "identity");
    const init: any = { method: req.method, headers: h, redirect: "manual" };
    if (req.method !== "GET" && req.method !== "HEAD") { init.body = req.body; init.duplex = "half"; }
    return await fetch("http://localhost:" + CFG.backendPort + url.pathname + url.search, init);
  } catch (e: any) {
    log("proxy error", e?.message || e);
    return new Response("Backend unavailable", { status: 502 });
  }
}

async function front(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (url.pathname === "/__ping") { cancelQuit(); return new Response("ok", { headers: cors }); }
    if (url.pathname === "/__quit") { scheduleQuit(); return new Response(null, { status: 204, headers: cors }); }
    if (CFG.serveStatic) {
      if (CFG.hasBackend && CFG.proxyPrefixes.some((p: string) => url.pathname.startsWith(p))) return proxy(req, url);
      return await serveStatic(url.pathname);
    }
    return new Response("ok", { headers: cors });
  } catch (e: any) {
    log("request error", url.pathname, e?.stack || e);
    return new Response("Internal error", { status: 500 });
  }
}

function openWindow(url: string) {
  const list = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const b = list.find(fs.existsSync);
  if (!b) { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); return; }
  spawn(b, ["--app=" + url, "--user-data-dir=" + path.join(dataDir, "browser-profile"), "--no-first-run", "--window-size=" + CFG.windowSize], { detached: true, stdio: "ignore" }).unref();
}

async function waitForBackend() {
  for (let i = 0; i < 120; i++) {
    try { await fetch("http://localhost:" + CFG.backendPort + "/", { redirect: "manual" }); return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function watchBrowser() {
  if (process.platform !== "win32") return;
  const profile = path.join(dataDir, "browser-profile").replace(/'/g, "''");
  const ps = "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" + profile + "') }).Count";
  let seen = false, misses = 0;
  const tick = () => {
    const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d: any) => { out += d; });
    p.on("close", () => {
      const n = parseInt(out.trim(), 10) || 0;
      if (n > 0) { seen = true; misses = 0; }
      else if (seen && ++misses >= 2) { log("browser closed, exiting"); process.exit(0); }
      setTimeout(tick, 2000);
    });
  };
  setTimeout(tick, 5000);
}

async function main() {
  const windowUrl = (p: number) => (CFG.serveStatic ? "http://127.0.0.1:" + p : "http://localhost:" + CFG.backendPort);
  let server: any = null;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: CFG.lifePort, fetch: front });
  } catch {
    try {
      const r = await fetch("http://127.0.0.1:" + CFG.lifePort + "/__ping");
      if (r.headers.get("x-app") === CFG.name) { openWindow(windowUrl(CFG.lifePort)); process.exit(0); }
    } catch {}
    if (CFG.serveStatic) server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: front });
    else { log("lifecycle port busy"); process.exit(1); }
  }
  //__BACKEND__
  const url = windowUrl(server.port);
  log("ready", url, "cwd:", process.cwd());
  openWindow(url);
  watchBrowser();
}
main();
`;

const backendSnippet = backend
  ? 'process.env.PORT = String(CFG.backendPort);\n  await import(' + JSON.stringify(path.posix.join("..", backendImportPath)) + ');\n  if (!(await waitForBackend())) log("backend did not respond on port", CFG.backendPort);'
  : "";
fs.writeFileSync(path.join(BUILD_DIR, "entry.ts"), entryTemplate.replace("__CFG__", JSON.stringify(cfg)).replace("//__BACKEND__", backendSnippet));

const shim = `import { Database as BunDatabase } from "bun:sqlite";
export class Database extends BunDatabase {
  constructor(file?: string, _opts?: any) { super(file && file !== "" ? file : ":memory:", { create: true }); }
  pragma(s: string, o?: { simple?: boolean }) {
    const rows: any[] = this.query("PRAGMA " + s).all();
    return o?.simple ? (rows[0] ? Object.values(rows[0])[0] : undefined) : rows;
  }
  prepare(sql: string): any {
    const st: any = super.prepare(sql);
    const get = st.get.bind(st);
    st.get = (...a: any[]) => get(...a) ?? undefined;
    return st;
  }
}
export default Database;
`;
fs.writeFileSync(path.join(BUILD_DIR, "shims", "better-sqlite3.ts"), shim);
fs.writeFileSync(path.join(BUILD_DIR, "tsconfig.json"), JSON.stringify({
  compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", esModuleInterop: true, skipLibCheck: true, strict: false, baseUrl: ".", paths: { "better-sqlite3": ["./shims/better-sqlite3.ts"] } },
}, null, 2));

// ------------------------------------------------------------------ compile
const outDir = path.join(ROOT, OUT_NAME, appName);
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(path.join(outDir, publicRel), { recursive: true, force: true });
fs.rmSync(path.join(outDir, appName + ".exe"), { force: true });
const exePath = path.join(outDir, appName + ".exe");

const bunArgs = ["build", "--compile"];
if (!flag("no-minify")) bunArgs.push("--minify");
if (!isWin) bunArgs.push("--target=bun-windows-x64");
if (!flag("console")) bunArgs.push("--windows-hide-console");
if (iconFile) bunArgs.push("--windows-icon=" + iconFile);
if (usesBetterSqlite) bunArgs.push("--tsconfig-override=" + path.join(BUILD_DIR, "tsconfig.json"));
bunArgs.push(path.join(BUILD_DIR, "entry.ts"), "--outfile", exePath);

if (run(bun, bunArgs, ROOT, isWin && bun === "bun") !== 0) {
  warn("Compile failed. Generated files are kept in .exe-build/ for inspection.");
  warn("If the error mentions an unknown flag, run `bun upgrade` or retry with --console.");
  process.exit(1);
}

// ------------------------------------------------------------------ assemble release
const lifecycleScript = (relative) => '<!--exe-lifecycle--><script>(function(){var u=' + JSON.stringify(relative ? "" : "http://127.0.0.1:" + lifePort) +
  ';fetch(u+"/__ping",{mode:"no-cors"}).catch(function(){});addEventListener("pageshow",function(){fetch(u+"/__ping",{mode:"no-cors"}).catch(function(){})});' +
  'addEventListener("pagehide",function(){navigator.sendBeacon(u+"/__quit")})})();</script>';

if (!flag("dry")) {
  if (staticSrc) {
    const dest = path.join(outDir, publicRel);
    fs.cpSync(staticSrc, dest, { recursive: true });
	for (const d of assetDirs) {
		const src = path.resolve(d), base = path.resolve(staticSrc);
		if (src === base || src.startsWith(base + path.sep)) continue;
		const target = path.join(dest, path.basename(d));
		if (!exists(target)) fs.cpSync(d, target, { recursive: true });
	}
    const idx = path.join(dest, "index.html");
    if (isFile(idx)) {
      let html = readText(idx);
      if (!html.includes("exe-lifecycle")) {
        const snippet = lifecycleScript(serveStatic);
        html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, snippet + "</body>") : html + snippet;
        fs.writeFileSync(idx, html);
      }
    }
  }
  if (backend) {
    for (const d of assetDirs) {
      const dest = path.join(outDir, rel(d));
      if (!exists(dest)) fs.cpSync(d, dest, { recursive: true });
    }
    for (const f of dbFiles) {
      const dest = path.join(outDir, rel(f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!exists(dest)) fs.copyFileSync(f, dest);
    }
  }
  if (flatTemp) fs.rmSync(flatTemp, { recursive: true, force: true });
  if (!flag("keep")) fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

console.log("");
log("Done: " + rel(exePath));
log("Ship the whole folder: " + rel(outDir) + "  (exe + " + publicRel + "/ + data files). Logs: data/app.log");

if (flag("zip") && isWin && !flag("dry")) {
  const zip = path.join(ROOT, OUT_NAME, appName + ".zip");
  fs.rmSync(zip, { force: true });
  run("powershell", ["-NoProfile", "-Command", "Compress-Archive -Path '" + outDir + "\\*' -DestinationPath '" + zip + "'"]);
  log("Zip: " + rel(zip));
}

if (!flag("no-run") && !flag("dry") && isWin) {
  log("Starting it...");
  spawnSync("cmd", ["/c", "start", "", exePath], { cwd: outDir });
}
