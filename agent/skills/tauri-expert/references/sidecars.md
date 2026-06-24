# Sidecar and External Binaries

Sidecars are non-Rust binaries (commonly Go, Python, .NET) shipped alongside the Tauri app and invoked via the shell plugin.

## Declaration

```json
{
  "bundle": {
    "externalBin": ["binaries/my-sidecar"]
  }
}
```

Paths are relative to `src-tauri/`. Each entry is a path **prefix** — Tauri appends the host's Rust target triple and `.exe` (Windows only).

## Naming convention

For `"binaries/my-sidecar"`, Tauri expects:

| Host platform | Required filename |
| --- | --- |
| Windows x64 | `binaries/my-sidecar-x86_64-pc-windows-msvc.exe` |
| Windows ARM64 | `binaries/my-sidecar-aarch64-pc-windows-msvc.exe` |
| macOS Intel | `binaries/my-sidecar-x86_64-apple-darwin` |
| macOS Apple Silicon | `binaries/my-sidecar-aarch64-apple-darwin` |
| Linux x64 | `binaries/my-sidecar-x86_64-unknown-linux-gnu` |
| Linux ARM64 | `binaries/my-sidecar-aarch64-unknown-linux-gnu` |

Detect the host triple in CI:

```bash
# Rust 1.78+
rustc --print host-tuple
# Older Rust
rustc -Vv | awk '/^host:/ {print $2}'
```

**Trap — Windows `.exe` is not optional.** A binary named `my-sidecar-x86_64-pc-windows-msvc` (no extension) on Windows fails the build with file-not-found.

**Trap — universal macOS binaries are not supported for sidecars.** Ship separate `x86_64-apple-darwin` and `aarch64-apple-darwin` binaries; `lipo`-merged fat binaries are rejected because Tauri matches by filename.

## .NET RID → Rust triple mapping

For .NET sidecars, publish per RID then rename:

| .NET RID | Rust target triple | Notes |
| --- | --- | --- |
| `win-x64` | `x86_64-pc-windows-msvc` | Output has `.exe` |
| `win-arm64` | `aarch64-pc-windows-msvc` | Output has `.exe` |
| `osx-x64` | `x86_64-apple-darwin` | No extension |
| `osx-arm64` | `aarch64-apple-darwin` | No extension |
| `linux-x64` | `x86_64-unknown-linux-gnu` | Dynamically linked (glibc) — build host glibc must be ≤ target glibc |
| `linux-arm64` | `aarch64-unknown-linux-gnu` | Dynamically linked (glibc) |
| `linux-musl-x64` | `x86_64-unknown-linux-musl` | Statically linked — preferred for portability |
| `linux-musl-arm64` | `aarch64-unknown-linux-musl` | Statically linked |

Recommended .NET publish flags for a single-file sidecar:

```bash
dotnet publish -r linux-x64 \
  --self-contained true \
  -p:PublishSingleFile=true \
  -p:PublishTrimmed=true \
  -c Release \
  -o ./publish/linux-x64
```

`PublishAot` is more compact but requires AOT-compatible code throughout the dependency graph — unsuitable for most library-heavy sidecars. For .NET project layout, dependency choices, and AOT compatibility, consult `dotnet-expert`.

Rename pattern:

```bash
TRIPLE=$(rustc --print host-tuple)
cp ./publish/linux-x64/MySidecar "src-tauri/binaries/my-sidecar-${TRIPLE}"
```

## Rust API

```rust
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

let sidecar = app.shell().sidecar("binaries/my-sidecar").unwrap();
let (mut rx, mut child) = sidecar.args(["--flag", "value"]).spawn().unwrap();

tauri::async_runtime::spawn(async move {
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => { /* handle */ }
            CommandEvent::Stderr(line) => { /* handle */ }
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }
});
```

The argument to `.sidecar()` is the `externalBin` path prefix, not the triple-suffixed filename. The legacy `tauri::api::process::Command` is removed in v2.

## JavaScript API

```javascript
import { Command } from '@tauri-apps/plugin-shell';

const output = await Command.sidecar('binaries/my-sidecar').execute();

// Streaming
const cmd = Command.sidecar('binaries/my-sidecar', ['--arg']);
cmd.stdout.on('data', line => console.log(line));
const child = await cmd.spawn();
```

## Capability requirements

```json
{
  "permissions": [
    "core:default",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        { "name": "binaries/my-sidecar", "sidecar": true }
      ]
    }
  ]
}
```

Use `shell:allow-spawn` for streaming. Arguments must be declared (or matched via regex validators) — undeclared args are rejected at runtime. `shell:default` does NOT grant sidecar execute.
