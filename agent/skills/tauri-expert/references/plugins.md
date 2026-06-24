# Plugin Ecosystem

All v2 plugins live at `tauri-apps/plugins-workspace`. Per-plugin minor versions in the 2.3–2.5.x family. Liveliness: Active, Risk: Low.

## Installation pattern

```bash
# Tauri CLI installs matched Rust + JS package versions together
cargo tauri plugin add <name>

# Or manually
cargo add tauri-plugin-<name>
pnpm add @tauri-apps/plugin-<name>
```

In `src-tauri/src/lib.rs`:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_<name>::init())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

Then grant permissions in `src-tauri/capabilities/default.json`.

## Cross-platform plugins

| Plugin | Crate | Purpose |
| --- | --- | --- |
| `shell` | `tauri-plugin-shell` | Subprocess execution, sidecar management, `open`. Required for sidecars. |
| `fs` | `tauri-plugin-fs` | File system read/write/watch. |
| `dialog` | `tauri-plugin-dialog` | Native file-open/save and message boxes. |
| `http` | `tauri-plugin-http` | Rust-backed HTTP client (bypasses CORS). |
| `notification` | `tauri-plugin-notification` | Native OS notifications. |
| `clipboard-manager` | `tauri-plugin-clipboard-manager` | System clipboard read/write. |
| `os` | `tauri-plugin-os` | Query OS type, version, locale, hostname. |
| `process` | `tauri-plugin-process` | `exit()`, `relaunch()`. |
| `store` | `tauri-plugin-store` | Persistent JSON key-value store. |
| `updater` | `tauri-plugin-updater` | In-app auto-update with signature verification. |
| `window-state` | `tauri-plugin-window-state` | Persist and restore window size/position. |
| `log` | `tauri-plugin-log` | Structured logging via the `log` façade. |
| `deep-link` | `tauri-plugin-deep-link` | Custom URL scheme handler. |
| `single-instance` | `tauri-plugin-single-instance` | Enforce one running instance. |
| `positioner` | `tauri-plugin-positioner` | Move windows to named positions. |
| `opener` | `tauri-plugin-opener` | Open files/URLs with the OS default handler. |
| `cli` | `tauri-plugin-cli` | Parse args defined in `tauri.conf.json`. |
| `localhost` | `tauri-plugin-localhost` | Serve via `http://localhost`. Security risk — see `references/frontend.md`. |
| `persisted-scope` | `tauri-plugin-persisted-scope` | Persist runtime FS scope grants. |
| `sql` | `tauri-plugin-sql` | sqlx-backed SQLite/MySQL/PostgreSQL. Desktop only currently. |
| `stronghold` | `tauri-plugin-stronghold` | Encrypted secure key-value store. |
| `upload` | `tauri-plugin-upload` | Multipart HTTP file upload. |
| `websocket` | `tauri-plugin-websocket` | WebSocket client. |

## Desktop-only plugins

`global-shortcut`, `autostart`.

## Mobile-only plugins

`barcode-scanner`, `biometric`, `geolocation`, `haptics`, `nfc`.

**Trap — JS package and Rust crate must come from compatible releases.** IPC message format can change between minor versions. Always update both together. `cargo tauri plugin add` does this automatically.

**Trap — `shell:default` does not grant sidecar execute.** It permits `open` (URLs) only. Add `shell:allow-execute` or `shell:allow-spawn` with the sidecar entry explicitly.
