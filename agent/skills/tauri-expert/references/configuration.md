# Configuration (tauri.conf.json)

The configuration file lives at `src-tauri/tauri.conf.json`. The `$schema` URL is version-pinned: `https://schema.tauri.app/config/<semver>` (e.g., `https://schema.tauri.app/config/2.11.0`). The schema is also the canonical reference at [schema.tauri.app/config/2](https://schema.tauri.app/config/2).

## Schema overview

| Top-level key | Required | Purpose |
| --- | --- | --- |
| `identifier` | Yes | Reverse-domain app ID (`com.example.myapp`). The only required key. |
| `productName` | No | Human-readable app name. |
| `version` | No | SemVer string, or path to a `package.json` with a `version` field. |
| `mainBinaryName` | No | Override the binary filename. |
| `app` | No | Runtime config — windows, security/CSP, capabilities, tray. Replaces the v1 `tauri` top-level key. |
| `build` | No | Dev/build pipeline — frontend dist path, dev URL, before-commands. |
| `bundle` | No | Bundler config — installer formats, icons, signing, externalBin, resources. |
| `plugins` | No | Per-plugin configuration keyed by plugin name. |

## v1 → v2 rename table

| v1 path | v2 path | Notes |
| --- | --- | --- |
| `tauri` (top-level) | `app` | Entire runtime section renamed |
| `tauri.allowlist.*` | `src-tauri/capabilities/*.json` | Allowlist replaced by capability files |
| `tauri.bundle.identifier` | `identifier` (top-level) | Promoted |
| `package.productName` | `productName` (top-level) | Promoted |
| `package.version` | `version` (top-level) | Promoted |
| `build.distDir` | `build.frontendDist` | Now accepts paths or URLs |
| `build.devPath` | `build.devUrl` | Renamed for clarity (it must be a URI) |
| `tauri.bundle.dmg` | `bundle.macOS.dmg` | Platform-specific nesting |
| `tauri.bundle.deb` | `bundle.linux.deb` | Platform-specific nesting |

`cargo tauri migrate` performs these renames automatically and converts the v1 allowlist into v2 capability files. Run it on the unmodified v1 project before manual cleanup.

## build

| Key | Type | Effect |
| --- | --- | --- |
| `build.beforeDevCommand` | string | Shell command run before `tauri dev`. Typically starts the frontend dev server. |
| `build.beforeBuildCommand` | string | Shell command run before `tauri build`. Typically builds the frontend assets. |
| `build.beforeBundleCommand` | string | Shell command run between Rust compile and bundling. |
| `build.devUrl` | URL | Frontend dev server URL. Tauri opens this in the WebView during `tauri dev`. |
| `build.frontendDist` | path or URL | Built frontend assets directory. **Read by `generate_context!()` at compile time**, not just at bundle time. |

## bundle

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `bundle.active` | bool | `false` | Gates the bundler phase only. Does NOT gate `generate_context!()` or icon reading. |
| `bundle.targets` | string \| array | `"all"` | Bundle formats to produce. Platform-scoped (see Cross-Platform Packaging). |
| `bundle.icon` | string[] | `[]` | Icon paths. **Read at every Cargo build, not just bundle time.** |
| `bundle.externalBin` | string[] | `[]` | Sidecar binary path prefixes. Tauri appends the host triple at build time. |
| `bundle.resources` | string[] | `[]` | Files copied into the bundle alongside the binary. |
| `bundle.createUpdaterArtifacts` | bool | `false` | Produce signed updater artifacts. Requires `TAURI_SIGNING_PRIVATE_KEY`. |

**Trap — `bundle.active = false` does not skip icon reading.** Icons are still loaded by the proc macro at compile time. See `references/build-bundle.md`.

## app

| Key | Type | Effect |
| --- | --- | --- |
| `app.windows[]` | array | Window configurations created at startup. Each entry is a `WindowConfig`. |
| `app.security.csp` | string \| object \| null | Content Security Policy. **`null` disables CSP entirely** — there is no implicit default. |
| `app.security.capabilities` | string[] | When set, ONLY listed capabilities are loaded. Auto-load of `capabilities/*.json` is disabled. |
| `app.security.dangerousDisableAssetCspModification` | bool | Bypass Tauri's nonce/hash injection. Use with extreme care. |
| `app.trayIcon` | object | System tray icon configuration. `iconPath` is read at compile time. |

`app.windows[]` minimum useful shape:

```json
{
  "label": "main",
  "title": "My App",
  "width": 1024,
  "height": 768,
  "resizable": true
}
```

**Trap — empty `app.security.csp` is not safe-by-default.** When unset or `null`, no CSP is injected. You must explicitly configure CSP and include `connect-src "ipc: http://ipc.localhost"` for IPC to function.

## Platform-specific config merging

Split per-OS overrides into `tauri.linux.conf.json`, `tauri.windows.conf.json`, `tauri.macos.conf.json` (and `.android.`/`.ios.` for mobile). Merge follows JSON Merge Patch (RFC 7396) — platform values override base values key-by-key.
