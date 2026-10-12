# make-exe

**Turn a web app folder into a double-click Windows `.exe`: no Node, no installs, no dependencies on the target machine.**

Copy one script into your project, run it, and get a `release/<app>/` folder containing a single executable that starts your backend (and frontend), opens it in its own app window, and quits when you close the window.

```powershell
node make-exe.mjs
```

> **Status:** works by auto-detecting common project layouts. It is a build helper, not a framework. Read [Limitations](#limitations) before relying on it for production distribution.

---

## How it works

1. **Discovers your project**: frontend, backend, database, assets, icon.
2. **Prepares**: installs Bun if missing, installs missing npm packages, runs your frontend build.
3. **Generates** a launcher (`.exe-build/entry.ts`) plus a `better-sqlite3` to `bun:sqlite` shim.
4. **Compiles** everything into one executable with [`bun build --compile`](https://bun.sh/docs/bundler/executables).
5. **Assembles** `release/<app>/` with the exe, static files, assets and database files.
6. **Runs it** (Windows) so you can test immediately.

At runtime the exe:

- sets its working directory to its own folder, so `process.cwd()`-relative paths just work;
- starts your backend in-process and waits for its port;
- opens the UI in a dedicated **Edge app window** (Chrome fallback, then default browser) with its own browser profile;
- exits when that window closes;
- allows a single instance per app (a second launch just opens another window);
- logs to `data/app.log`, which helps because the console is hidden.

## What it detects

| Area | Detected |
|---|---|
| Frontend | Angular, Vite, Create React App, Vue CLI, Parcel; `public/`, `www/`, `static/`, `web/` folders; flat `index.html` + `app.js` + `styles.css` in the root; frontends in `frontend/`, `client/`, `web/`, `ui/`, `app/` |
| Backend | Express, Fastify, Koa, Hono, `http.createServer`, `Bun.serve`; entry from `package.json` `main`, `scripts.start`, or common names (`server`, `index`, `app`, `main` in the root, `src/`, `dist/`, `backend/`, `server/`, `api/`) |
| Port | `process.env.PORT \|\| 3000`, `const PORT = ...`, `listen(3000)`, `port: 3000` (override with `--port`) |
| Database | `better-sqlite3` (swapped for `bun:sqlite` automatically), `*.db` / `*.sqlite` / `*.sqlite3` files |
| Assets | `assets/`, `images/`, `img/`, `fonts/`, `icons/`, `media/`, `static/`, `uploads/`; first `.ico` file becomes the exe icon |

## Modes

| Situation | Mode |
|---|---|
| Backend serves its own static files (`express.static`, `sendFile`, ...) | The backend runs as-is on its own port; the exe opens a window on it |
| Frontend build + backend that does not serve files | The exe serves the frontend and proxies `/api/*` to the backend |
| No backend | The exe is a static file server |

## Requirements

**To build** (one machine, needs internet the first time):

- Windows 10/11 (also cross-compiles from Linux/macOS with `--target=bun-windows-x64`; auto-run is Windows-only)
- [Node.js](https://nodejs.org) 18 or newer (includes npm)
- [Bun](https://bun.sh): installed automatically if missing

**To run the result:** nothing. Windows 10/11 with Edge (preinstalled) or Chrome.

Behind a firewall? See [Offline and restricted networks](#offline-and-restricted-networks).

## Usage

```powershell
# 1. copy make-exe.mjs into your project root
# 2. run it
node make-exe.mjs

# output
release/<app-name>/
  <app-name>.exe
  public/            # frontend files
  data/              # app.log, browser profile, your database files
```

Ship the **whole folder**, not just the exe.

### Flags

| Flag | Meaning |
|---|---|
| `--name=X` | App/exe name (default: `package.json` name or folder name) |
| `--out=release` | Output folder |
| `--port=3000` | Override the detected backend port |
| `--icon=app.ico` | Exe icon |
| `--console` | Keep the console window (use this to debug) |
| `--no-minify` | Disable minification |
| `--skip-frontend-build` | Use the existing frontend build output |
| `--no-run` | Do not start the exe after building |
| `--zip` | Also create `release/<app>.zip` (Windows) |
| `--keep` | Keep `.exe-build/` (generated files) for inspection |
| `--dry` | Discover and generate, but do not install or compile |

## Data and file locations

The exe sets its working directory to its own folder. Files your app reads or writes by relative path (databases, uploads, `public/`) live next to the exe, in the same relative locations as in your project.

- Database files found in the project are copied into `release/<app>/` on the first build and are **never overwritten** on later builds.
- Rebuilds replace the exe and the `public/` folder only. `data/` and database files are kept.
- Do not install into `Program Files` (it is not writable by normal users). Use a normal folder such as Desktop, Documents or `C:\Apps`.

### Compiled backends that use `__dirname`

Inside a Bun-compiled exe, `__dirname` does not point at the exe folder. For backends in a subfolder such as `dist/`, the script copies the compiled files to `.exe-build/backend/` and prepends exe-relative `__dirname` / `__filename` definitions, so patterns like `path.join(__dirname, '../public')` resolve to the release folder. If your entry file lives in the project root, change the source to use `process.cwd()` instead.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Nothing happens on launch | Run the build with `--console`, or read `data/app.log` |
| `Could not resolve: "<package>"` | A package is imported but not installed. The script installs missing packages with `npm install --no-save`; if that failed, run `npm install <package>` |
| Script/asset loads as `text/html` (MIME error) | The file is missing at that URL path; your catch-all route returned `index.html`. Check the exact path under `public/`, and that the backend serves from the release folder (see `__dirname` above) |
| Process keeps running after closing the window | Strict CSP (for example `helmet`) can block the close-window signal. The launcher also watches the browser process; make sure you use a version that includes `watchBrowser()` |
| Port already in use | An old instance is still running. `taskkill /IM <app>.exe /F`, then relaunch |
| Unknown flag `--windows-hide-console` or `--tsconfig-override` | Update Bun: `bun upgrade` |
| `npm install` tries to compile `better-sqlite3` | Run `npm install --ignore-scripts`; the exe uses `bun:sqlite`, not the native module |

## Offline and restricted networks

The script needs a working `bun.exe`. It looks on `PATH`, then in `%USERPROFILE%\.bun\bin\bun.exe`.

1. `npm install -g bun` (uses the npm registry)
2. `winget install Oven-sh.Bun`
3. Download `bun-windows-x64.zip` from the [Bun releases](https://github.com/oven-sh/bun/releases) on another machine and copy `bun.exe` to `%USERPROFILE%\.bun\bin\`
4. Behind a proxy: set `HTTPS_PROXY` / `HTTP_PROXY` and `npm config set proxy` / `https-proxy`

Easiest for locked-down machines: build on a machine with internet, then copy `release/<app>/` to the locked one. The exe makes no network requests for its own runtime.

## Limitations

- **Windows-focused.** The exe is a Windows target. Auto-run works only when building on Windows.
- **SQLite only.** `better-sqlite3` is shimmed (`prepare`, `get`, `all`, `run`, `exec`, `pragma`, `transaction`). `.iterate()` and `.pluck()` are not supported. `sqlite3`, Prisma, Mongoose, `pg` and similar packages are not swapped and may not work inside a Bun exe; the script warns when it sees them.
- **No server-side rendering.** Next.js and SvelteKit work only as static exports.
- **Proxy mode** forwards `/api/*` only and does not support WebSockets. Let the backend serve its own files if you need them.
- **Express under Bun** works for typical apps, but not every Node-specific package or native addon does. Test your app.
- **Unsigned exe.** Windows SmartScreen or antivirus may warn about unsigned executables. Code signing is outside the scope of this tool.
- Heuristic detection can guess wrong on unusual layouts. Use `--dry --keep` to inspect what was generated, and `--port`, `--name` to override.

## Project layout produced by the build

```
.exe-build/            # generated, removed after a successful build (use --keep)
  entry.ts             # launcher: window, lifecycle, proxy/static server
  shims/better-sqlite3.ts
  tsconfig.json        # maps better-sqlite3 to the shim
  backend/             # patched copy of a compiled backend (if it uses __dirname)
release/<app>/         # what you ship
```

## License

Add the license of your choice (for example MIT).
