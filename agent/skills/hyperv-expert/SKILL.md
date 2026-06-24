---
name: hyperv-expert
description: 'Hyper-V reference for the hyperv-expert subagent — architecture, nested virtualization, WSL2 plumbing, WHPX, PowerShell module, VBS/HVCI boundaries, CI runners.'
disable-model-invocation: true
---

# Hyper-V Expert

Read-only reference for **Microsoft Hyper-V** — the Type-1 hypervisor that underpins Windows Server / Windows Client virtualization, WSL2's lightweight utility VM, the Windows Hypervisor Platform (WHPX), and the VBS / HVCI / Credential Guard security stack. Primary data source is `learn.microsoft.com`. **All version-dependent defaults (e.g. `.wslconfig` keys) must be sourced from the live MS Learn page for the user's Windows build — do not assert them from this reference.**

This skill exists to support distribution-substrate questions (TheSemicolon/pi_config#99, #119) where Hyper-V is the load-bearing layer beneath WSL2 and any KVM-on-Windows path. Paired with `wsl2-expert` for the guest-side surface.

---

## Three landmines — read first

1. **`Enable-VMNestedVirtualization` is a phantom cmdlet.** It is widely cited in third-party blogs and does not exist in the `Hyper-V` PowerShell module. The canonical enablement is `Set-VMProcessor -VMName <name> -ExposeVirtualizationExtensions $true` applied to a **stopped** L1 VM. If a question repeats the phantom cmdlet, correct it.

2. **Three distinct Windows optional features. Do not conflate.**

   | Feature name | Provides | Required for |
   |---|---|---|
   | `Microsoft-Hyper-V-All` | Full Type-1 hypervisor + management stack (Hyper-V Manager, PowerShell module, VMMS) | Running Hyper-V VMs natively |
   | `HypervisorPlatform` | Windows Hypervisor Platform (WHPX) — third-party-accelerator API | QEMU `--accel whpx`, VirtualBox 6+, AOSP emulator |
   | `VirtualMachinePlatform` | The substrate WSL2 and Windows Sandbox use | WSL2; **does not** require the full Hyper-V role |

   The most common Hyper-V documentation error is conflating the **role** with the **Platform**. WSL2 needs `VirtualMachinePlatform`, not `Microsoft-Hyper-V-All`.

3. **Nested virtualization is enabled per-VM, not per-host.** The host CPU must satisfy prerequisites (Intel VT-x+EPT or AMD-V+RVI), but the toggle is per-L1-guest before boot. **Additionally, VBS / HVCI / Credential Guard running inside the L1 guest will suppress an L2 hypervisor (KVM, libkrun, etc.) even when the per-VM toggle is on.** This is the nested-KVM-on-WSL2 failure mode investigated in #119 — surface it explicitly when the question implies nested KVM.

---

## 1. Architecture

Hyper-V is a Type-1 (bare-metal) hypervisor. Once installed, the existing Windows installation becomes the **root partition** running atop the hypervisor; guest VMs run in **child partitions**. Communication between root and children flows over **VMBus**; **integration services** (heartbeat, time sync, shutdown, KVP, VSS, guest services) are the in-guest agents that consume VMBus.

- **Generation 1 VMs** — BIOS firmware, IDE boot disk, broad legacy-OS support.
- **Generation 2 VMs** — UEFI firmware, SCSI boot disk, Secure Boot support, faster boot. Required for most modern features.
- **Dynamic memory** — balloon-driver-based memory ballooning between guest and host based on a min/max range.
- **Checkpoints** — *production* (VSS-quiesced, application-consistent) vs *standard* (saved-state snapshot). Production is the default in modern Windows.

Sources:

- `learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/reference/hyper-v-architecture`
- `learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/plan/should-i-create-a-generation-1-or-2-virtual-machine-in-hyper-v`
- `learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/manage/manage-hyper-v-integration-services`
- `learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/manage/enable-or-disable-checkpoints-in-hyper-v`

---

## 2. Nested virtualization

Required when an L1 guest must itself run a hypervisor — the WSL2-on-Windows-on-cloud-VM case, KVM-inside-Hyper-V-VM, or running Hyper-V Server inside a Hyper-V VM.

**Prerequisites:**

- Intel VT-x with EPT, or AMD-V with RVI (AMD support added in Windows Server 2022 / Windows 11).
- L1 VM must be **stopped** when toggling the flag.
- L1 VM must have static memory (no dynamic memory ballooning) on Intel; AMD relaxed this.

**Enablement:**

```powershell
# Stop the L1 VM first
Stop-VM -Name 'MyVM'

# Expose virt extensions to the L1 guest
Set-VMProcessor -VMName 'MyVM' -ExposeVirtualizationExtensions $true

# Verify
Get-VM -Name 'MyVM' | Get-VMProcessor |
    Select-Object VMName, ExposeVirtualizationExtensions, Count
```

**The "Hyper-V eats KVM" failure mode** — if VBS / HVCI / Credential Guard is active inside the L1 guest, it consumes the virtualization extensions, leaving none for an L2 hypervisor. `/dev/kvm` will not appear inside a WSL2 distro on such a host even when `nestedVirtualization=true` and the per-VM toggle is on. Diagnose with `Win32_DeviceGuard` (§5).

Source: `learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/user-guide/nested-virtualization`

---

## 3. WSL2 host plumbing

WSL2 runs a single shared lightweight utility VM managed by the Windows host's `VirtualMachinePlatform` substrate. It is not a full Hyper-V VM in the management sense — it does not appear in `Get-VM` and is not configured via the Hyper-V cmdlets.

**`.wslconfig` knob relevant to nested KVM:**

```ini
# %UserProfile%\.wslconfig
[wsl2]
nestedVirtualization=true
```

The default value is **version-dependent** across Windows builds. Do **not** assert a universal default in answers; instead direct the user to:

- `learn.microsoft.com/en-us/windows/wsl/wsl-config` — canonical `.wslconfig` reference, including the per-build default for `nestedVirtualization`.
- `learn.microsoft.com/en-us/windows/wsl/about` — origin of the "lightweight utility VM" terminology.
- `learn.microsoft.com/en-us/windows/wsl/install` — install prerequisites (`VirtualMachinePlatform`, not `Microsoft-Hyper-V-All`).

For diagnosing whether `/dev/kvm` is reachable inside a WSL2 distro, defer to `wsl2-expert` for the guest-side check and surface the host-side prerequisites here:

1. CPU supports VT-x+EPT or AMD-V+RVI.
2. `VirtualMachinePlatform` feature is enabled.
3. `.wslconfig` has `[wsl2] nestedVirtualization=true` (or build default is true).
4. No VBS / HVCI / Credential Guard active in the WSL2 utility VM.

---

## 4. Windows Hypervisor Platform / WHPX

The Windows Hypervisor Platform is a Microsoft-stable user-mode API that lets third-party hypervisors and emulators use Hyper-V's hypervisor without owning the root partition. Consumers: QEMU (`--accel whpx`), VirtualBox 6+, Android Studio emulator (HAXM successor).

- Optional-feature name: **`HypervisorPlatform`** (distinct from `Microsoft-Hyper-V-All`).
- Coexists cleanly with WSL2 (which uses `VirtualMachinePlatform`).
- Does **not** provide a Hyper-V management surface — `Get-VM` will not see WHPX-driven guests.

Sources:

- `learn.microsoft.com/en-us/virtualization/api/`
- `learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/hypervisor-platform`

---

## 5. PowerShell management surface

Authoritative module index: `learn.microsoft.com/en-us/powershell/module/hyper-v/`.

**Core VM lifecycle:**

| Cmdlet | Purpose |
|---|---|
| `Get-VM` | Enumerate VMs (Hyper-V-managed only — not WSL2's utility VM, not WHPX guests). |
| `New-VM` | Create a VM. Specify `-Generation 2` for modern guests. |
| `Set-VM` | Modify VM properties (memory, processor count via `Set-VMProcessor`, etc.). |
| `Set-VMProcessor` | Per-VM CPU config. **`-ExposeVirtualizationExtensions $true` is the canonical nested-virt enablement.** |
| `Start-VM` / `Stop-VM` / `Save-VM` | Power state. Toggle nested-virt only when stopped. |
| `Get-VMSwitch` / `New-VMSwitch` | Virtual switch enumeration / creation (External / Internal / Private). |

**Feature install / state (DISM module, not Hyper-V module):**

```powershell
# Query feature state
Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform
Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform

# Install Hyper-V role + management tools (requires reboot)
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All

# Install WHPX (does not install the full role)
Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform

# Install VirtualMachinePlatform (the WSL2 substrate)
Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
```

Cmdlet doc pages:

- `learn.microsoft.com/en-us/powershell/module/hyper-v/set-vmprocessor`
- `learn.microsoft.com/en-us/powershell/module/hyper-v/get-vm`
- `learn.microsoft.com/en-us/powershell/module/hyper-v/new-vm`
- `learn.microsoft.com/en-us/powershell/module/hyper-v/set-vm`
- `learn.microsoft.com/en-us/powershell/module/hyper-v/new-vmswitch`
- `learn.microsoft.com/en-us/powershell/module/hyper-v/get-vmswitch`
- `learn.microsoft.com/en-us/powershell/module/dism/get-windowsoptionalfeature`
- `learn.microsoft.com/en-us/powershell/module/dism/enable-windowsoptionalfeature`

---

## 6. Security boundaries — VBS / HVCI / Credential Guard / WDAG

These are Hyper-V-isolation-backed Windows security features. They consume the same virtualization extensions an L2 hypervisor would, which is the root cause of nested-KVM failures despite "everything looks enabled."

| Feature | What it isolates | Interaction with L2 hypervisor |
|---|---|---|
| **VBS** (Virtualization-Based Security) | Carves out a secure kernel using Hyper-V; foundation for HVCI and Credential Guard. | When active in the L1 guest, suppresses L2 hypervisors. |
| **HVCI** (Hypervisor-Protected Code Integrity) | Kernel-mode code integrity enforced by the secure kernel. Subset of VBS. | Same as VBS — same root cause. |
| **Credential Guard** | Isolates LSA secrets in the secure kernel. | Same. |
| **WDAG** (Windows Defender Application Guard) | Hyper-V-isolated browser/Office sandbox. | Uses Hyper-V isolation primitives; not directly conflicting with WSL2. |

Diagnostic for VBS state inside an L1 Windows guest:

```powershell
Get-CimInstance -ClassName Win32_DeviceGuard `
    -Namespace root\Microsoft\Windows\DeviceGuard |
    Select-Object VirtualizationBasedSecurityStatus,
                  SecurityServicesRunning,
                  SecurityServicesConfigured
```

`VirtualizationBasedSecurityStatus = 2` ("running") means VBS is active and L2 hypervisors will be blocked. Verify property names against the live MS Learn page before quoting.

Sources:

- `learn.microsoft.com/en-us/windows/security/hardware-security/enable-virtualization-based-protection-of-code-integrity`
- `learn.microsoft.com/en-us/windows/security/identity-protection/credential-guard/`
- `learn.microsoft.com/en-us/windows/security/application-security/application-isolation/microsoft-defender-application-guard/md-app-guard-overview`

---

## 7. CI / automation

**GitHub Actions Microsoft-hosted runners (`windows-latest`, `windows-2022`, `windows-2019`):** nested virtualization is **not exposed**. The runner image manifest does not list KVM, HAXM, or any L2-hypervisor capability. Workflows that need nested virt must use **self-hosted runners** on capable hardware/cloud, or move to a Linux runner with KVM (`ubuntu-latest` exposes `/dev/kvm` for QEMU/KVM use cases).

Verify against the current runner image manifest before committing to a CI design:

- `github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md` (and the `Windows2025-Readme.md` / `Windows2019-Readme.md` siblings)

**Azure VM families with nested-virt support:** Dv3 / Dsv3, Ev3 / Esv3, Dv4, Ev4, Dv5, Ev5 and successors. Older D / E / A families do not support nested virt. Self-hosted runners on these sizes work; on smaller / older sizes, they don't.

Sources:

- `learn.microsoft.com/en-us/azure/virtual-machines/dv3-dsv3-series`
- `learn.microsoft.com/en-us/azure/virtual-machines/acu` (cross-family comparison)

---

## 8. Verification recipes

Hand these back to users to run on their own host. Do not invent variants.

**Confirm full Hyper-V role state:**

```powershell
Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All |
    Select-Object FeatureName, State
```

**Confirm WHPX state (separate from full role):**

```powershell
Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform |
    Select-Object FeatureName, State
```

**Confirm VirtualMachinePlatform (WSL2 substrate):**

```powershell
Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform |
    Select-Object FeatureName, State
```

**Confirm per-VM nested-virt state:**

```powershell
Get-VM -Name 'MyVM' | Get-VMProcessor |
    Select-Object VMName, ExposeVirtualizationExtensions, Count
```

**Diagnose VBS / HVCI runtime state (the L2-hypervisor blocker):**

```powershell
Get-CimInstance -ClassName Win32_DeviceGuard `
    -Namespace root\Microsoft\Windows\DeviceGuard |
    Select-Object VirtualizationBasedSecurityStatus,
                  SecurityServicesRunning,
                  SecurityServicesConfigured
```

**Cross-reference into the WSL2 guest (bridges to `wsl2-expert`):**

```bash
# Run inside the WSL2 distro
ls -l /dev/kvm
# Expected when nested-KVM is reachable:
#   crw-rw---- 1 root kvm 10, 232 ...
# Missing means: VBS active in utility VM, .wslconfig nestedVirtualization unset,
# CPU lacks prereqs, or host doesn't have VirtualMachinePlatform enabled.
```

---

## Cross-domain handoffs

- **WSL2 guest-side surface** (`wsl.exe` CLI, `/etc/wsl.conf`, distro lifecycle, `wsl --import` packaging) → `wsl2-expert`.
- **Container image authoring on Windows** → `docker-expert`.
- **CI pipeline integration on Azure DevOps** → `azure-devops-expert`. GitHub Actions integration: orchestrator inline.
- **Security review of a Windows-host distribution topology** → `security-review-expert` via `/security-review`.

## Constraints

- Cite the live MS Learn page for any version-dependent default (build-specific behaviors of `.wslconfig`, `Win32_DeviceGuard` property semantics, runner-image capabilities). Do not restate defaults from this reference.
- Do not invoke `Enable-VMNestedVirtualization` — it does not exist.
- Distinguish the three optional features (`Microsoft-Hyper-V-All`, `HypervisorPlatform`, `VirtualMachinePlatform`) every time enablement is discussed.
- Surface the VBS-suppresses-L2-hypervisor failure mode whenever a nested-KVM question is asked; it is the most common silent failure.
