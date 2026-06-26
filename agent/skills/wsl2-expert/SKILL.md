---
name: wsl2-expert
description: 'WSL2 reference for the wsl2-expert subagent — wsl.exe CLI, /etc/wsl.conf, .wslconfig, lifecycle and --import packaging, systemd, networking, interop, diagnostics.'
disable-model-invocation: true
---

# WSL2 Expert

Read-only reference for **Windows Subsystem for Linux 2** — the `wsl.exe` command surface, the per-distro `/etc/wsl.conf` and the host-side `.wslconfig` configuration files, distro lifecycle including the `wsl --export` / `wsl --import` packaging path, systemd-in-WSL2, networking modes (NAT vs mirrored), Windows ↔ Linux interop, and runtime diagnostics. Primary data source is `learn.microsoft.com/en-us/windows/wsl/`. **All version-dependent defaults must be sourced from the live MS Learn page for the user's Windows build — do not assert them from this reference.**

This skill is the **guest-side / CLI-side counterpart** to `hyperv-expert`. The Hyper-V root-partition mechanics, nested-virtualization toggles, the `VirtualMachinePlatform` optional feature, the WHPX API, and the VBS / HVCI / Credential Guard interaction with L2 hypervisors all live in `hyperv-expert`; cross-link rather than duplicate. The skill exists to support distribution-substrate questions (psmfd/pi-config#99 — particularly option η, distributing pi_config as a pre-populated rootfs imported via `wsl --import`).

---

## Three landmines — read first

1. **`/etc/wsl.conf` ≠ `.wslconfig`.** They share a documentation page (`wsl-config`) and that is the primary cause of confusion.

   | File | Scope | Location | Consumed at |
   |---|---|---|---|
   | `/etc/wsl.conf` | per-distro | inside the Linux guest filesystem | distro start |
   | `.wslconfig` | global, all distros | `%UserProfile%\.wslconfig` on the Windows host | utility-VM start |

   Misplacing a key fails silently — the file parses cleanly and the wrong consumer ignores the wrong section. Always state which file you mean.

2. **systemd is opt-in, not on by default.** Requires `[boot] systemd=true` in `/etc/wsl.conf` *plus* `wsl --shutdown` to apply. Minimum WSL runtime is 0.67.6; on older runtimes the key is silently ignored. Cross-reference `wsl --version` whenever a systemd-related diagnostic is requested.

3. **`\\wsl$\<Distro>\` (legacy) vs `\\wsl.localhost\<Distro>\` (modern).** Both UNC roots resolve to the distro filesystem on modern Windows. Current MS Learn pages document `\\wsl.localhost\`. New tooling should target the modern form; old blogs and answers cite `\\wsl$\` exclusively. Lead with `\\wsl.localhost\` and footnote the legacy form.

---

## 1. WSL versions and architecture

WSL exists in two architecturally distinct generations:

- **WSL 1** — a syscall-translation layer in the Windows kernel. No real Linux kernel. Faster filesystem performance for Windows-mounted paths, but significant compatibility gaps for kernel-dependent workloads.
- **WSL 2** — a real Linux kernel running inside a lightweight utility VM managed by the Windows host's `VirtualMachinePlatform` substrate. Full syscall fidelity, `/dev/kvm` reachable when nested virt is enabled, real systemd support since runtime 0.67.6.

Per-distro version is independently selectable: `wsl --set-version <Distro> 2` migrates a distro between generations. `wsl --set-default-version 2` controls what new installs use.

WSL is now distributed as a Microsoft Store package on modern Windows builds (Windows 11 22H2+; opt-in on older builds via `wsl --update`). The Store-package model decouples WSL runtime updates from Windows servicing — the runtime version (`wsl --version`) and the kernel version are both independently updatable.

Sources:

- `learn.microsoft.com/en-us/windows/wsl/about`
- `learn.microsoft.com/en-us/windows/wsl/compare-versions`
- `learn.microsoft.com/en-us/windows/wsl/install`
- `learn.microsoft.com/en-us/windows/wsl/install-manual`

---

## 2. `wsl.exe` CLI surface

Authoritative reference: `learn.microsoft.com/en-us/windows/wsl/basic-commands`. Verify exact flag spellings against this page on first use — newer flags (`--import-in-place`, the `--cd ~` shortcut, etc.) appear without notice.

**Lifecycle:**

```powershell
wsl --install                       # install WSL + default distro
wsl --install -d <Distro>           # install a named distro
wsl --list --online                 # wsl -l -o; available distros
wsl --list --verbose                # wsl -l -v; local distros + version + state
wsl --update                        # update the WSL runtime / kernel
wsl --shutdown                      # hard-stop the utility VM (apply .wslconfig / [boot])
wsl --terminate <Distro>            # stop one distro without touching the utility VM
wsl --unregister <Distro>           # delete a distro registration (DESTRUCTIVE)
```

**Distro management:**

```powershell
wsl --set-default <Distro>                                 # wsl -s
wsl --set-default-version <1|2>
wsl --set-version <Distro> <1|2>
wsl --export <Distro> <file.tar>                           # tarball export
wsl --import <Name> <InstallLocation> <file.tar> --version 2
wsl --import-in-place <Name> <ext4.vhdx>                   # newer; verify against basic-commands
```

**Runtime invocation:**

```powershell
wsl -d <Distro>                       # run shell in a specific distro
wsl -d <Distro> -- bash -lc 'cmd'     # run a one-shot command
wsl -u <user>                         # run as a specific user
wsl --cd <path>                       # set initial working directory
wsl --status                          # default distro / version / kernel
wsl --version                         # WSL, kernel, WSLg, MSRDC, Direct3D, Windows
```

**Filesystem interop UNC paths:**

- `\\wsl.localhost\<Distro>\` — modern; document new tooling against this.
- `\\wsl$\<Distro>\` — legacy alias; still functional, do not target for new code.

The `wsl --unregister <Distro>` command is destructive and irreversible — always surface that loudly when recommending it.

Source: `learn.microsoft.com/en-us/windows/wsl/filesystems` for the UNC path semantics.

---

## 3. `/etc/wsl.conf` — per-distro, in-guest

Lives inside each Linux distro at `/etc/wsl.conf`. Consumed when the distro starts. Keys grouped by section; full reference at `learn.microsoft.com/en-us/windows/wsl/wsl-config`.

```ini
[automount]
enabled=true                # mount Windows drives under /mnt
mountFsTab=true             # process /etc/fstab on start
root=/mnt/                  # mount root for Windows drives
options="metadata,umask=22,fmask=11,case=off"

[network]
generateHosts=true          # generate /etc/hosts from Windows hosts file
generateResolvConf=true     # generate /etc/resolv.conf from Windows DNS
hostname=mybox              # override default hostname

[interop]
enabled=true                # allow launching Windows binaries from WSL
appendWindowsPath=true      # append Windows PATH to Linux PATH

[user]
default=alice               # default user for `wsl -d <Distro>` (no -u)

[boot]
systemd=true                # enable systemd as PID 1 (requires WSL ≥ 0.67.6)
command="echo started"      # arbitrary command run as root at distro start
```

**DrvFs mount options under `[automount] options`** — `metadata` enables Linux-style permissions/ownership on Windows volumes; `case=off|dir|force` controls per-directory case-sensitivity behavior. These interact with case-sensitive Linux tooling (git, make) running over Windows-mounted paths and are the most common source of "works on `/home/`, breaks on `/mnt/c/`" issues.

Apply changes via `wsl --terminate <Distro>` (cheap) or `wsl --shutdown` (full restart, required for `[boot]` changes).

---

## 4. `.wslconfig` — global, on the Windows host

Lives at `%UserProfile%\.wslconfig`. Consumed when the utility VM starts. Affects all WSL2 distros simultaneously. Same MS Learn page (`wsl-config`).

```ini
[wsl2]
memory=8GB                       # cap utility VM memory
processors=4                     # vCPU count
swap=4GB                         # swap allocation; 0 disables
swapFile=D:\\wsl-swap.vhdx       # swap-file location
localhostForwarding=true         # legacy NAT-mode interop knob
kernel=C:\\path\\to\\bzImage     # custom kernel
kernelCommandLine=cgroup_no_v1=all
nestedVirtualization=true        # required for /dev/kvm in guest
vmIdleTimeout=60000              # ms before idle-shutdown
networkingMode=NAT               # or "mirrored" on supported builds
dnsTunneling=true
firewall=true
autoProxy=true

[experimental]
autoMemoryReclaim=gradual        # dropable | gradual
sparseVhd=true                   # ext4.vhdx auto-shrink
useWindowsDnsCache=true
bestEffortDnsParsing=true
hostAddressLoopback=true
```

**Do not assert version-dependent defaults from this reference.** The defaults for `nestedVirtualization`, `networkingMode`, `dnsTunneling`, `firewall`, and `autoProxy` are all build-dependent; they have shifted across recent WSL releases. Always direct the reader to the live `wsl-config` page for their exact build, and verify with `wsl --version` first.

Apply changes via `wsl --shutdown` (no `wsl --update` required).

The `[experimental]` section graduates keys into `[wsl2]` over time without a stable cadence — re-check section placement on the live page rather than restating from this reference.

Sources:

- `learn.microsoft.com/en-us/windows/wsl/wsl-config`
- `learn.microsoft.com/en-us/windows/wsl/networking` (for `networkingMode`, `firewall`, `dnsTunneling`)

---

## 5. Distro lifecycle and the `wsl --import` packaging path

**This is the load-bearing section for #99 option η** (distributing pi_config as a pre-populated WSL2 rootfs).

### Producing a rootfs tarball

A WSL2 distro is, at the OS-image level, a flat root filesystem tarball. The two canonical production paths:

1. **Export from a Docker / OCI container.** Build the desired environment into a container image, instantiate a stopped container, then export its filesystem:

   ```bash
   docker create --name pi-wsl2 myorg/pi-config-rootfs:latest
   docker export pi-wsl2 > pi-config-rootfs.tar
   docker rm pi-wsl2
   ```

   Cross-link to `docker-expert` for image-authoring and `docker export` flag specifics. Note: `docker export` produces a *flat* tarball with no image metadata, which is what `wsl --import` consumes.

2. **Author from a chroot / debootstrap pipeline** (Linux build host). Outside this skill's scope — defer to distribution authoring tools.

### Import semantics

```powershell
wsl --import <Name> <InstallLocation> <rootfs.tar> --version 2
```

- `<Name>` — registered distro name (visible in `wsl -l -v`). Must be unique on the host.
- `<InstallLocation>` — directory where the resulting `ext4.vhdx` is created. Must already exist.
- `<rootfs.tar>` — flat rootfs tarball; gzipped tarballs (`.tar.gz`) are accepted on modern WSL.
- `--version 2` — explicit; do not omit.

After import, the distro is usable via `wsl -d <Name>`. On first launch the runtime may read `/etc/wsl.conf` and `/etc/wsl-distribution.conf` from inside the guest — OOBE handling on raw tarball-imported distros has historically depended on the WSL runtime version and registration path; verify against the live `build-custom-distro` page for the user's runtime before relying on first-launch OOBE behavior for arbitrary tarballs.

### Tarball provenance is a supply-chain trust boundary

`wsl --import` of a tarball grants the **tarball author** code execution as the importing user on first launch via any of: `/etc/wsl.conf [boot] command=`, `/etc/wsl-distribution.conf [oobe] command=`, distro-shipped systemd unit files (when systemd is enabled), or any binary on PATH inside the rootfs that the user invokes. Treat unfamiliar `.tar` / `.tar.gz` rootfs candidates the same way you would treat an unsigned `.exe` installer:

- Verify provenance (signed checksums published by the distro author over a transport-secured channel).
- Inspect `/etc/wsl.conf` `[boot] command=` and `/etc/wsl-distribution.conf` `[oobe] command=` before importing.
- Audit any setuid binaries (`find . -perm -u+s -type f`) and any systemd units shipped under `etc/systemd/system/` and `usr/lib/systemd/system/`.

For pi_config option η the **distributor** side of this trust boundary is ours: a published rootfs needs a documented checksum / signature surface, and the published `Install.ps1` should not blindly accept arbitrary tarball arguments.

### `/etc/wsl-distribution.conf` — distro-author contract

Lives inside the tarball at `/etc/wsl-distribution.conf` and controls the first-boot OOBE experience for end users. Keys (verify against the live `build-custom-distro` page before relying on schema specifics):

- `[oobe]` — `command` (path to a script run on first boot, typically to prompt for default-user creation), `defaultUid`, `defaultName`.
- `[shortcut]` — Start-menu / Terminal-profile integration (icon, distro display name).
- `[windowsterminal]` — Windows Terminal profile auto-installation.

**Do not invent OOBE schema keys from memory.** Fetch the `build-custom-distro` page and copy the schema. Schema has evolved across runtime releases.

### Tarball-distro vs Store-distro from the user's perspective

| Aspect | Tarball-imported (`wsl --import`) | Microsoft-Store-distributed |
|---|---|---|
| Discoverability | Manual — user runs `wsl --import` | `wsl --install -d <Distro>` from `wsl -l -o` |
| Updates | None unless author ships an update mechanism | Store auto-updates the package, runtime auto-updates via `wsl --update` |
| Default user | Set via `/etc/wsl.conf [user] default=` shipped in tarball | Created via OOBE on first launch |
| Uninstall | `wsl --unregister <Name>` | Standard Store-app uninstall |

For pi_config option η, the tarball-imported path is the realistic distribution shape: a single `pi-config-rootfs.tar.gz` artifact plus a small `Install.ps1` that runs `wsl --import` against a chosen install location.

Sources:

- `learn.microsoft.com/en-us/windows/wsl/use-custom-distro`
- `learn.microsoft.com/en-us/windows/wsl/build-custom-distro`
- `github.com/microsoft/WSL/releases` (for runtime version gates on the OOBE schema)

---

## 6. systemd in WSL2

Enable in `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

Then `wsl --shutdown` from PowerShell to apply.

Once enabled, `systemctl` works as expected: services start at distro start, sockets activate on demand, timers fire, journalctl is populated. Most of the breakage observed in the wild is from older WSL runtimes (< 0.67.6) where the key is silently ignored — confirm with `wsl --version` first. WSL is now distributed via the Microsoft Store, so `wsl --update` is the canonical refresh path before chasing systemd-related diagnostics.

What does *not* work the same as on a regular Linux distro: anything that assumes a real init session at PID 1 across a reboot. WSL has no reboot — `wsl --shutdown` followed by re-entering the distro is the closest analog.

Cite the `wsl-config` page for the schema and `github.com/microsoft/WSL/releases` for the version gate.

---

## 7. Networking modes

Two modes selectable via `[wsl2] networkingMode` in `.wslconfig`:

| Mode | Behavior |
|---|---|
| `NAT` | Historical default. WSL utility VM gets a private subnet; `localhostForwarding=true` proxies guest-bound localhost traffic from Windows. Windows-bound localhost traffic from the guest hits the Windows host's loopback. |
| `mirrored` | Modern (Windows 11, recent WSL builds). Guest sees the Windows host's network interfaces directly; localhost is shared natively. Significantly different semantics — breaks some Docker-in-WSL2 setups, changes firewall behavior, and interacts with `dnsTunneling` and `autoProxy`. |

Adjacent knobs:

- `firewall=true|false` — applies Windows Defender Firewall rules to the WSL utility VM. Mirrored mode + firewall=true is the modern secure-by-default posture.
- `dnsTunneling=true|false` — sends DNS queries through the Windows resolver instead of the Linux guest's own. Improves VPN behavior, can break custom `/etc/resolv.conf` setups.
- `autoProxy=true|false` — propagates Windows proxy settings into the guest as `HTTPS_PROXY` etc.
- `localhostForwarding=true` — NAT-mode-only; ignored in mirrored mode.

**Mirrored mode is not a drop-in replacement for NAT.** Test before flipping in any environment that depends on Docker-in-WSL2, custom resolv.conf, or specific firewall posture.

Source: `learn.microsoft.com/en-us/windows/wsl/networking`.

---

## 8. Interop (Windows ↔ Linux)

**Linux → Windows** — `cmd.exe`, `powershell.exe`, and any Windows binary on `PATH` are launchable from the WSL shell. With `[interop] appendWindowsPath=true` (default), the Windows PATH is appended to the Linux PATH. With `appendWindowsPath=false`, only explicitly-pathed Windows binaries work — useful when Windows binaries shadow Linux ones (e.g. `node`).

**Windows → Linux** — `wsl.exe` is the universal entry point:

```powershell
wsl -d Ubuntu -- bash -lc "echo hello from $(hostname)"
```

stdout/stderr stream back to the Windows-side process; exit code propagates. This is the canonical pattern for CI workflows and Windows automation that needs to run a Linux command.

**Environment passing** — `WSLENV` is the bridge. Windows-side environment variables listed in `WSLENV` (with optional `/p` for path-translation, `/l` for list-separator translation) become available in the guest. Symmetric for guest-to-Windows when `wsl.exe` returns to a Windows process via interop.

**WSLg** — GUI Linux apps render through Windows on Windows 11 (and Windows 10 with manual install). Wayland + X11 + PulseAudio bridges are runtime-managed; users do not configure `DISPLAY`. The `WSLg` component version is reported by `wsl --version`.

Sources:

- `learn.microsoft.com/en-us/windows/wsl/interop`
- `learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps`

---

## 9. Diagnostic recipes

Hand these back for users to run; do not invent variants.

**Runtime version surface (Windows-side):**

```powershell
wsl --version    # WSL, kernel, WSLg, MSRDC, Direct3D, Windows
wsl --status     # default distro, default version, kernel version
wsl -l -v        # local distros + version + state
```

**Guest-side identity:**

```bash
cat /proc/version                   # kernel version + WSL build string
ls /run/WSL                         # confirms running under WSL2
uname -r                            # kernel release
```

**Networking mode confirmation:**

```bash
wslinfo --networking-mode           # NAT or mirrored; verify against wslinfo doc
```

(If `wslinfo` is unavailable on the user's runtime, `wsl --version` plus inspection of `[wsl2] networkingMode` in `.wslconfig` is the fallback.)

**Nested-KVM availability (the `/dev/kvm` check):**

```bash
ls -l /dev/kvm
# Expected when reachable:
#   crw-rw---- 1 root kvm 10, 232 ...
```

If `/dev/kvm` is missing, the cause is host-side, not guest-side. Surface the host-side checklist via `hyperv-expert`:

1. CPU supports VT-x+EPT (Intel) or AMD-V+RVI (AMD).
2. `VirtualMachinePlatform` Windows feature enabled.
3. `[wsl2] nestedVirtualization=true` in `%UserProfile%\.wslconfig` (or build default is true).
4. No VBS / HVCI / Credential Guard active in the utility VM consuming the virt extensions.

Source: `learn.microsoft.com/en-us/windows/wsl/troubleshooting`.

---

## 10. CI considerations

**GitHub Actions Microsoft-hosted Windows runners** (`windows-latest`, `windows-2022`, `windows-2025`):

- `wsl.exe` itself **is available** — workflows can `wsl --install -d Ubuntu` and run a distro.
- **Nested virtualization is not exposed**, so `/dev/kvm` will not appear inside the WSL2 distro on these runners. KVM-dependent tooling (libkrun, QEMU/KVM) will not function.
- Workflows that need nested KVM must use **self-hosted runners** on capable hardware (Azure Dv3+/Ev3+ etc.) or move the KVM-dependent step to a Linux runner with `/dev/kvm` exposed (`ubuntu-latest` does expose it on Microsoft-hosted Linux runners).

Verify the runner-image manifest against the live README before committing to a CI design — the WSL inclusion / kernel version / available distros are documented per runner image:

- `github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md`
- `github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md`

---

## Cross-domain handoffs

- **Hyper-V host-side surface** (root partition, nested-virt CPU prereqs, `Set-VMProcessor -ExposeVirtualizationExtensions`, `VirtualMachinePlatform` vs `Microsoft-Hyper-V-All` vs `HypervisorPlatform`, VBS / HVCI / Credential Guard suppression of L2 hypervisors) → `hyperv-expert`.
- **Docker rootfs export workflow** for §5 packaging (`docker export`, image-authoring choices, multi-stage builds that produce slim rootfs) → `docker-expert`.
- **GitHub Actions runner-image capabilities** → orchestrator inline.
- **PowerShell-driven Windows automation around `wsl.exe`** → orchestrator inline (no `powershell-expert` agent exists).

## Constraints

- Cite the live MS Learn page for any version-dependent default (`.wslconfig` defaults across builds, `wsl-config` section/key placement, `wsl-distribution.conf` schema, runner-image WSL inclusion). Do not restate defaults from this reference.
- Always distinguish `/etc/wsl.conf` (per-distro, in-guest) from `.wslconfig` (global, on the Windows host).
- Always lead with `\\wsl.localhost\` for UNC paths; mention `\\wsl$\` only as legacy backward-compatible alias.
- Always confirm `wsl --version` before diagnosing systemd issues — pre-0.67.6 runtimes silently ignore `[boot] systemd=true`.
- Never recommend disabling VBS / HVCI / Credential Guard to unblock `/dev/kvm` — that is a `hyperv-expert` boundary and the answer is "different host topology," not "weaken security." Surface the cross-link explicitly.
- Never recommend `[wsl2] firewall=false` as a workaround for connectivity issues — diagnose the underlying rule (`Get-NetFirewallRule`, mirrored-mode interaction) instead. Disabling the WSL firewall integration weakens the Windows host security posture for all distros simultaneously.
- Treat `wsl --import` of an unfamiliar rootfs tarball as importing an unsigned executable: the tarball author gains code execution as the importing user on first launch via `[boot] command=` / OOBE / shipped systemd units. Always require provenance + checksum + content-audit before recommending a tarball import.
- Surface the `wsl --unregister <Distro>` destructiveness loudly whenever it appears in a recommendation.
