# Build and Bundle Phases

The single most consequential concept in Tauri: configuration keys do not all run at the same phase. Misunderstanding this produces opaque proc-macro panics during `cargo clippy`.

| Phase | What runs | Reads at this phase | Does NOT run |
| --- | --- | --- | --- |
| `cargo check` | Type-check + proc-macro expansion | `tauri.conf.json`, icons, frontendDist, capabilities, CSP injection | beforeDev/beforeBuild commands, bundler |
| `cargo build` / `cargo build --release` | Full Rust compilation | Same as `cargo check` | beforeDev/beforeBuild commands, bundler |
| `cargo clippy` | Lints + proc-macro expansion | Same as `cargo check` | beforeDev/beforeBuild commands, bundler |
| `tauri dev` | beforeDevCommand → wait for devUrl → `cargo build` (debug) → run binary → watch | All Cargo-build inputs + dev server | bundler |
| `tauri build` | beforeBuildCommand → `cargo build --release` → beforeBundleCommand → bundler (if `bundle.active`) | All Cargo-build inputs + bundle target inputs | — |
| `tauri build --no-bundle` | Same as above without the bundler phase | Cargo-build inputs only | bundler |
| `tauri bundle` | beforeBundleCommand → bundler only (does not recompile) | Already-compiled binary, bundle target inputs | Rust compilation |

## `generate_context!()` codegen

`tauri::generate_context!()` is a proc macro in `tauri-macros` that delegates to `tauri-codegen::context_codegen()`. At every Cargo invocation it:

1. Reads and parses `tauri.conf.json`
2. Reads `frontendDist` (when a path) and embeds the assets in the binary
3. Reads icons from `bundle.icon` or default paths and embeds the window icon
4. Reads tray icon from `app.trayIcon.iconPath` if configured
5. Parses `src-tauri/capabilities/*.json` and embeds the resolved capability set
6. Injects CSP nonces and content hashes for embedded assets

**Trap — `cargo clippy` panics on missing icons.** When `bundle.icon` is empty or absent, `generate_context!()` falls back to platform-default paths: `icons/icon.ico` (Windows target), `icons/icon.icns` (macOS dev), `icons/icon.png` (other). If the file does not exist, the proc macro panics with `failed to open icon ... No such file or directory`. This fires during `cargo clippy` because clippy expands proc macros. The official docs page says icons are needed "at bundle time, not compile time" — this is **incorrect**; the source code is authoritative. Tracked in `tauri-apps/tauri` discussion #14355.

**Resolution paths:**

- Run `cargo tauri icon <source.png>` to generate the full icon set.
- Commit a placeholder `src-tauri/icons/icon.png` (and `.ico` on Windows-targeting CI).
- Generate icons in CI before `cargo clippy` runs.

There is no config-only workaround.

## Other proc macros

| Macro | Purpose |
| --- | --- |
| `#[tauri::command]` | Marks a Rust function as IPC-callable; generates serialization glue. |
| `tauri::generate_handler![cmd_a, cmd_b]` | Registers `#[tauri::command]` functions into the invoke handler. Pass to `Builder::invoke_handler`. |

`tauri::Manager` is a trait imported with `use tauri::Manager`, not a derive macro.
