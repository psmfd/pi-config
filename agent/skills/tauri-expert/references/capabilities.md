# Capabilities

v2 replaces the v1 allowlist with capability files in `src-tauri/capabilities/`. Each file declares which permissions apply to which windows on which platforms.

## Capability file shape

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main-capability",
  "description": "Default capability for the main window",
  "windows": ["main"],
  "platforms": ["linux", "macOS", "windows"],
  "permissions": [
    "core:default",
    "fs:allow-read-file",
    "shell:allow-execute"
  ]
}
```

The `$schema` path points to a generated file at `src-tauri/gen/schemas/desktop-schema.json` that does not exist until the first `cargo tauri build` or `cargo tauri dev`. IDE schema validation is broken in fresh checkouts until first build.

## Auto-load vs explicit reference

Default behavior: every JSON/TOML file under `src-tauri/capabilities/` is automatically loaded.

**Trap — explicit reference disables auto-load globally.** Once any capability is listed in `app.security.capabilities`, ONLY listed capabilities are used; all other files in the directory are ignored. There is no "merge with auto-load" mode. Either rely on auto-load entirely, or list every capability you want active.

## Permission identifier format

Format: `<plugin>:<permission>`. The `tauri-plugin-` prefix is stripped — use the short name:

- `core:default`, `core:window:allow-close`, `core:event:allow-listen`
- `fs:allow-read-file`, `shell:allow-execute`, `dialog:allow-open`

Permission names follow `allow-<command>` (grant) or `deny-<command>` (block, overrides allows). Permission **sets** use names without the `allow-`/`deny-` prefix (e.g., `core:default`, `core:window:default`).

## `core:default` composition

`core:default` is a permission set that bundles the default sets of the core sub-plugins:

- `core:app:default`, `core:event:default`, `core:image:default`, `core:menu:default`, `core:path:default`, `core:resources:default`, `core:tray:default`, `core:webview:default`, `core:window:default`

**Trap — `core:window:default` excludes mutating operations.** It grants read-only window queries (`is-visible`, `is-maximized`, `inner-size`, etc.) but NOT `allow-close`, `allow-minimize`, `allow-maximize`, `allow-set-size`, `allow-set-title`, `allow-show`, `allow-hide`. Programmatic window control from JS requires explicit grants.

## Scoped permissions

Filesystem and URL permissions accept scope restrictions:

```json
{
  "identifier": "fs:allow-read-file",
  "allow": [{ "path": "$HOME/**" }]
}
```

Scope variables: `$HOME`, `$APPDATA`, `$RESOURCE`, `$TEMP`, `$DESKTOP`, `$DOCUMENT`, `$DOWNLOAD`, `$EXE`, `$LOG`. Wildcards: `*` (single segment), `**` (recursive).
