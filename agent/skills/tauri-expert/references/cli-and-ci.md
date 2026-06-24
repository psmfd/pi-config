# CLI Reference, CI, and Code Signing

## CLI Reference

The CLI is invoked as `cargo tauri <command>` (after `cargo install tauri-cli --version "^2.0"`) or `pnpm tauri <command>` (via `@tauri-apps/cli` devDependency). The pnpm form is recommended for reproducible CI.

| Command | Purpose |
| --- | --- |
| `tauri init` | Scaffold `src-tauri/` in an existing frontend project. Use `--ci` for non-interactive mode. |
| `tauri dev` | Start dev mode — runs `beforeDevCommand`, waits for `devUrl`, compiles, launches with hot-reload. |
| `tauri build` | Compile release binary and generate platform bundles. |
| `tauri build --debug` | Release bundle with debug symbols. |
| `tauri build --no-bundle` | Compile binary only, skip installer generation. |
| `tauri build --bundles <types>` | Generate only specified bundle types (comma-separated). |
| `tauri info` | Print environment diagnostics — **always request first in a bug report**. |
| `tauri icon <source.png>` | Generate full icon set from a 1024×1024 source. |
| `tauri migrate` | Automated v1 → v2 migration. |
| `tauri plugin add <name>` | Install matched Rust crate and JS package versions. |
| `tauri signer generate -w <path>` | Generate updater signing key pair. |
| `tauri bundle` | Bundle an already-compiled release binary without recompiling. |

`tauri info` reports OS/arch, Node/Rust versions, CLI versions, WebView2 version (Windows), Xcode (macOS), and project Tauri versions from `Cargo.lock`. Version skew between `@tauri-apps/api` (JS) and the `tauri` crate is a common source of IPC breakage and is the first thing to check.

## CI and Code Signing

GitHub Actions is the canonical CI surface. The official `tauri-apps/tauri-action@v0` wraps the build, signing, and release-creation steps.

### 3-OS matrix

```yaml
name: publish
on:
  push:
    branches: [release]
jobs:
  publish-tauri:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            args: --target aarch64-apple-darwin
          - platform: macos-latest
            args: --target x86_64-apple-darwin
          - platform: ubuntu-22.04
            args: ''
          - platform: ubuntu-22.04-arm   # public repos only (free since Jan 2025)
            args: ''
          - platform: windows-latest
            args: ''
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: latest

      - uses: actions/setup-node@v4
        with:
          node-version: lts/*
          cache: pnpm

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: >-
            ${{ matrix.platform == 'macos-latest'
                && 'aarch64-apple-darwin,x86_64-apple-darwin'
                || '' }}

      - uses: swatinem/rust-cache@v2
        with:
          workspaces: ./src-tauri -> target

      - name: install Linux deps
        if: startsWith(matrix.platform, 'ubuntu')
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends \
            libwebkit2gtk-4.1-dev \
            libayatana-appindicator3-dev \
            librsvg2-dev \
            patchelf \
            build-essential \
            curl \
            wget \
            file \
            libxdo-dev \
            libssl-dev

      - run: pnpm install --frozen-lockfile

      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: app-v__VERSION__
          releaseName: App v__VERSION__
          releaseDraft: true
          args: ${{ matrix.args }}
```

### Linux system dependencies

Tauri 2 uses GTK 4.1 — `libwebkit2gtk-4.1-dev`, not 4.0. The 4.0 package is absent on Ubuntu 24.04 and Debian 13 (Trixie). The Ayatana fork (`libayatana-appindicator3-dev`) is the actively maintained appindicator package; the legacy `libappindicator3-dev` is unmaintained and absent on Debian 13. `libgtk-3-dev` is pulled in transitively and need not be listed.

| Package | Ubuntu 22.04 | Ubuntu 24.04 | Debian 13 |
| --- | --- | --- | --- |
| `libwebkit2gtk-4.1-dev` | Yes | Yes | Yes |
| `libwebkit2gtk-4.0-dev` | Yes (v1 only) | No | No |
| `libayatana-appindicator3-dev` | Yes | Yes | Yes |
| `libappindicator3-dev` | Virtual (→ ayatana) | No | No |
| `librsvg2-dev`, `libxdo-dev`, `patchelf` | Yes | Yes | Yes |

### Cross-compilation guidance

| Target | Approach |
| --- | --- |
| macOS universal | `--target universal-apple-darwin` on `macos-latest`, both targets installed via `dtolnay/rust-toolchain`. ~2× build time. |
| Linux ARM64 | Native `ubuntu-22.04-arm` runner (free for public repos). Cross-compile from x86_64 is strongly discouraged — webkit/appindicator headers are not packaged for cross-builds. |
| Windows ARM64 | `aarch64-pc-windows-msvc` target on `windows-latest`. `tauri-action` lacks formal support (issue #952); invoke `cargo tauri build` directly. NSIS installer runs under x86 emulation; the binary is native ARM64. |
| Linux from non-Linux | Don't. Use a native Linux runner. |

### Code signing

| Platform | Required env vars |
| --- | --- |
| macOS | `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` |
| Windows (PFX) | `WINDOWS_CERTIFICATE` (base64 .pfx), `WINDOWS_CERTIFICATE_PASSWORD` |
| Windows (Azure Trusted Signing) | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` with `trusted-signing-cli`. Recommended modern approach. |
| Linux | RPM signing via `TAURI_SIGNING_RPM_KEY` (ASCII-armored GPG) and `TAURI_SIGNING_RPM_KEY_PASSPHRASE`. AppImage and `.deb` signing typically deferred to repository distribution. |
| Updater | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — required when `bundle.createUpdaterArtifacts: true`. |

`tauri-action@v0` reads these env vars automatically when set. Store as GitHub repository secrets — never commit certificate files or their base64 encodings.

### Linux CI requires a display server

`tauri build` and `tauri dev` on Linux CI need either a real display or Xvfb:

```bash
export DISPLAY=:99
Xvfb :99 -screen 0 1024x768x24 &
```

Or `xvfb-run tauri build` if `xvfb` is installed.

### Common pitfalls

- **`fail-fast: true` (the default)** wastes 10–30 minutes of macOS notarization when an unrelated platform fails. Always set `fail-fast: false`.
- **`rust-cache` `workspaces:` misconfiguration** — the default `. -> target` points at the repo root. Tauri's target lives at `src-tauri/target/`. Without `workspaces: ./src-tauri -> target` the cache stores nothing useful.
- **`pnpm/action-setup` ordering** — must run before `actions/setup-node` because `cache: pnpm` reads pnpm's store path that does not exist until pnpm is installed.
- **`pnpm install` without `--frozen-lockfile`** — silently mutates `pnpm-lock.yaml` mid-build, breaking reproducibility.
- **`cargo tauri build` exits 0 on warnings** — clippy is the strict gate. Run `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` separately.
- **`generate_context!()` icon panic at `cargo clippy`** — see `references/build-bundle.md`. Generate icons before clippy runs in CI.

For shell-script idioms around these CI commands (argument parsing, retries, cross-platform shims), consult `shell-expert`. For GitHub Releases artifact upload after the bundle phase, consult `gh-cli-expert`. For Azure DevOps pipeline equivalents, consult `azure-devops-expert`.
