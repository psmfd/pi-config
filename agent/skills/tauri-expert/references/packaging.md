# Cross-Platform Packaging

## Bundle types per platform

| Platform | Available targets |
| --- | --- |
| Linux | `deb`, `rpm`, `appimage` |
| macOS | `dmg`, `app` |
| Windows | `nsis` (recommended), `msi` (WiX-based) |

Specify via `bundle.targets` or CLI flag: `tauri build --bundles deb,appimage`.

## Icon pipeline

All icons live in `src-tauri/icons/`. Generate the full set from a single 1024×1024 PNG:

```bash
cargo tauri icon ./app-icon.png
```

| File | Platform | Purpose |
| --- | --- | --- |
| `icon.png` | All Linux/macOS | Required by `generate_context!()` for non-Windows targets |
| `icon.ico` | Windows | Required by `generate_context!()` for Windows targets; multi-layer (16/24/32/48/64/256) |
| `icon.icns` | macOS bundle | Required at bundle time for `.app`/`.dmg` |
| `32x32.png`, `128x128.png`, `128x128@2x.png` | Linux | Desktop integration sizes |
| `Square*.png`, `StoreLogo.png` | Windows Store | AppX targets (currently unused) |

PNG inputs must be square, RGBA (not indexed), 32-bit per pixel.

**Compile-time vs bundle-time icon needs:**

- Compile time: the icon for the current Cargo target triple (`icon.png` on Linux/macOS targets, `icon.ico` on Windows targets) must exist.
- Bundle time: the platform-specific icon for each `bundle.targets` entry must exist (e.g., `.icns` for macOS bundles).

**Mobile icons live elsewhere.** Android: `src-tauri/gen/android/app/src/main/res/`. iOS: `src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/`. These directories are created by `cargo tauri android init` / `cargo tauri ios init`.
