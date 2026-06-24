# Frontend Integration

## `build` keys recap

```json
{
  "build": {
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build",
    "devUrl": "http://localhost:5173",
    "frontendDist": "../dist"
  }
}
```

- `frontendDist` accepts a path (embedded at compile time) or a URL (loaded at runtime).
- `devUrl` is consumed only by `tauri dev`.

## Production serving

Tauri serves embedded assets via a custom protocol in production:

| Platform | Scheme |
| --- | --- |
| macOS, Linux | `tauri://localhost` |
| Windows | `http://tauri.localhost` |

**Trap — Windows changed scheme between v1 and v2.** v1 used `https://tauri.localhost`; v2 uses `http://tauri.localhost`. This resets IndexedDB, LocalStorage, and cookies for users upgrading from v1 apps. Set `app.windows[].useHttpsScheme: true` to preserve v1 storage.

## Framework configurations

**Vite (recommended for SPA):**

```json
{
  "build": {
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build",
    "devUrl": "http://localhost:5173",
    "frontendDist": "../dist"
  }
}
```

Add `server.strictPort: true` in `vite.config.ts` so Vite fails fast if 5173 is taken. Set `build.target` conditionally using `process.env.TAURI_ENV_PLATFORM`: `chrome105` for Windows (WebView2), `safari13` for macOS/Linux (WebKit).

**Next.js (static export only):**

```json
{ "build": { "frontendDist": "../out", "devUrl": "http://localhost:3000" } }
```

`next.config.mjs` requires `output: 'export'` and `images: { unoptimized: true }`. SSR, API routes, and middleware are incompatible — they require a Node.js runtime that does not exist in production Tauri.

**SvelteKit (static adapter):**

```json
{ "build": { "frontendDist": "../build", "devUrl": "http://localhost:5173" } }
```

Use `@sveltejs/adapter-static` with `adapter({ fallback: 'index.html' })`. Add a root `+layout.ts` with `export const ssr = false;`.

**SPA mode is the path of least resistance.** Any framework feature requiring a server (SSR, API routes, middleware) must be replaced with Tauri commands and plugins.

## WebView differences

WebKit (macOS/Linux) lags Chromium (Windows WebView2) on CSS and JS feature support. Test on all three platforms — features that work on Windows can silently fail on macOS/Linux.

## tauri-plugin-localhost is a security risk

`tauri-plugin-localhost` serves assets on a real `http://localhost:<port>` HTTP server. Any process on the machine can connect. Use only when a tool genuinely requires a real HTTP origin; the custom protocol is preferred.
