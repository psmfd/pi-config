<!--
Archived 2026-05-25 per ADR-0020 (rescind substrate ζ / smolvm pack).
This file was previously agent/skills/smolvm-expert/SKILL.md — an active
agent-loadable skill paired with the smolvm-expert subagent. Both the skill
and the subagent have been removed from the active surface. The original
skill-loader frontmatter (name / description / disable-model-invocation)
was stripped during the archive move to prevent re-indexing as an active
skill. Body content is preserved verbatim as historical reference; do not
rely on it for current substrate guidance — see ADR-0020 for the rescission
rationale and the post-rescission substrate matrix (α + η + κ).
-->

# smolvm Expert

Read-only reference for [smolvm](https://github.com/smol-machines/smolvm) — a Rust CLI + SDK for ephemeral and persistent Linux microVMs built on [libkrun](https://github.com/containers/libkrun). Sub-second cold start, per-workload hardware isolation, OCI-image compatible, packable into self-contained `.smolmachine` binaries. Primary data source is the upstream README and the SDK docs at `smolmachines.com/sdk/`.

## Scope

**In scope:**

- CLI surface — `smolvm machine {run, create, start, stop, exec, cp, delete, list}`, `smolvm pack {create, run}`, common flags
- Smolfile TOML schema — `image`, `net`, `[network]`, `[dev]`, `[auth]`
- SDK — TypeScript (`smolvm` on npm) and Python (`smolvm` on PyPI); `Machine` class lifecycle; **server-mode prerequisite** (`http://127.0.0.1:8080`); language presets
- Isolation model — libkrun VMM, Hypervisor.framework (macOS Apple Silicon) vs KVM (Linux), per-workload kernel, virtio balloon elastic memory, virtio-blk root disk
- Networking — default-off, opt-in via `--net`, allow-list egress via `--allow-host`, TCP/UDP only (no ICMP)
- SSH-agent forwarding — `--ssh-agent`, `SSH_AUTH_SOCK` requirement, keys never enter the guest
- Volume mounts — `-v /host:/guest`, directories only (no single files), `/workspace` priority over default storage-disk workspace
- Resource sizing — `--cpus`, `--mem`, virtio balloon semantics
- GPU acceleration — virtio-gpu / Venus (Vulkan-over-virtio), host requirements (virglrenderer + mesa-vulkan-* on Linux; bundled on macOS)
- `.smolmachine` pack format — self-contained portable binaries, architecture-bound
- Agent sandbox patterns — running pi or any agent inside a smolvm; spawn-task-collect-destroy lifecycle
- Platform support matrix — macOS 11+ on Apple Silicon (Intel untested), Linux x86_64 + aarch64 with `/dev/kvm`

**Out of scope (refer elsewhere):**

- OCI image authoring consumed by `--image` → `docker-expert`
- Helm/Kubernetes deployment of workloads that *could* run in smolvm → `helm-expert` / `vcluster-expert`
- libkrun / libkrunfw internals beyond what's needed to explain VMM behavior → upstream `github.com/containers/libkrun` directly
- GitHub Actions / Azure DevOps pipeline authoring that drives smolvm → orchestrator inline / `azure-devops-expert`
- macOS code signing for Hypervisor.framework entitlements (smolvm distribution is pre-signed; only re-signing forks needs this) → outside this skill

## Source Authority Hierarchy

The upstream project is the only first-party source. Prefer in this order:

1. **Upstream README** (`github.com/smol-machines/smolvm/blob/main/README.md`) — authoritative on CLI surface, flag semantics, Smolfile schema, isolation model, GPU acceleration host requirements, platform support matrix
2. **SDK docs site** (`smolmachines.com/sdk/`) — authoritative on `Machine` API for TypeScript and Python, server-mode setup, language presets
3. **GitHub Releases** (`github.com/smol-machines/smolvm/releases`) — authoritative on version pins, breaking-change notes, platform binary availability
4. **`docs/DEVELOPMENT.md`** in upstream repo (if present) — build-from-source paths, contributor-facing internals (only relevant when forking)
5. **libkrun upstream** (`github.com/containers/libkrun`) — VMM internals when needed to explain elastic memory, vsock channel, kernel surface
6. **Community sources** (Discord, blogs, GitHub issues) — last resort; corroborate against upstream README before citing

Project velocity is high (active development, frequent releases). Always confirm version-sensitive claims against the installed `smolvm --version` and the matching release notes before asserting flag or behavior specifics.

## CLI Surface (essentials)

```text
smolvm machine run [--net] [--image <oci>] [-it] [--cpus N] [--mem N] [-v host:guest]
                   [--allow-host <host>...] [--ssh-agent] [--gpu] [--name <name>]
                   [-s Smolfile] -- <argv...>
smolvm machine create [<name>] [--net] [--image <oci>] [-s Smolfile]
smolvm machine start --name <name>
smolvm machine stop --name <name>
smolvm machine exec --name <name> [-it] [--ssh-agent] -- <argv...>
smolvm machine cp <src> <name>:<dst>            # host → guest (and reverse)
smolvm machine delete --name <name>
smolvm machine list

smolvm pack create --image <oci> -o <output>    # produces .smolmachine
./<output> run -- <argv...>                     # rehydrate and execute
```

- `run` is ephemeral (cleaned up on exit); `create` + `start` is persistent (state survives `stop`/`start`).
- `--net` is opt-in; without it the guest has zero network.
- `--allow-host` only applies when `--net` is on; it converts default-allow egress into default-deny + allowlist.
- `-it` is the standard interactive+tty pair (matches Docker convention).
- `--` separates smolvm flags from the in-guest command line.
- Defaults: 4 vCPUs, 8 GiB RAM (elastic via virtio balloon — host only commits actual usage).

## Smolfile (TOML)

```toml
image = "python:3.12-alpine"
net = true
cpus = 2                       # optional
mem = 4096                     # optional, MiB
gpu = false                    # optional; see GPU section
gpu_vram = 2048                # MiB, default 4096

[network]
allow_hosts = ["api.stripe.com", "db.example.com"]

[dev]
init = ["pip install -r requirements.txt"]   # commands run after start
volumes = ["./src:/app"]                     # directory mounts (no single files)

[auth]
ssh_agent = true               # forward host SSH agent into guest
```

Apply with `smolvm machine create <name> -s Smolfile` then `smolvm machine start --name <name>`. Use `run -s Smolfile -- <cmd>` for an ephemeral one-shot.

## SDK (TypeScript and Python)

Both SDKs require a running `smolvm` server (default `http://127.0.0.1:8080`). The server is a separate process from the CLI — start it explicitly before any SDK call (or surface a startup health check in the integrating app).

**TypeScript** (`npm install smolvm`):

```ts
import { Machine } from 'smolvm';

// TS Machine.create() returns a running machine; Python's constructor
// does not — call await machine.start() in the Python flow below.
const machine = await Machine.create({ name: 'my-machine' });
const result = await machine.exec(['echo', 'Hello!']);
console.log(result.stdout);
await machine.stop();
await machine.delete();
```

**Python** (`pip install smolvm`):

```python
from smolvm import Machine, MachineConfig

async with Machine(MachineConfig(name="my-machine")) as machine:
    await machine.start()
    result = await machine.exec(["echo", "Hello!"])
    print(result.stdout)
```

The `Machine` API mirrors the CLI lifecycle (`create` / `start` / `exec` / `stop` / `delete`). Language presets (Python / Node.js) provide quick-helper constructors for common image + init combinations. Volume mounts, GPU enable, network allow-lists, and SSH agent forwarding are all set via the `MachineConfig` (Python) or the create options object (TypeScript). For exact method signatures and error types fetch the live page at `smolmachines.com/sdk/api-reference/machine` and `…/error-handling` — the SDK is on an active release cadence and the canonical signatures live there.

## Isolation model (one paragraph)

Each VM is a separate libkrun-launched microVM with its own Linux kernel ([libkrunfw](https://github.com/smol-machines/libkrunfw)) running on `Hypervisor.framework` (macOS) or KVM (Linux). The hypervisor boundary is the trust boundary — host filesystem, network, credentials, and processes are not visible from inside the guest unless explicitly forwarded. Network egress is off by default. SSH agent forwarding is over a vsock channel; private keys never leave the host. GPU access (when `--gpu`) is via virtio-gpu / Venus, which is Vulkan-only — the guest does **not** get a real GPU PCI device. Volume mounts are virtio-fs directory mounts. Image format is OCI (same as Docker / podman); no Docker daemon required.

## Agent sandbox patterns

The most common pattern for "run an agent (or untrusted tool) in a smolvm":

1. **Spawn-task-collect-destroy** — `machine create` with a minimal image, `cp` the task input in, `exec` the agent / tool, `cp` the artifacts out, `delete`. Each invocation is a fresh kernel, fresh filesystem, fresh memory.
2. **Persistent sandbox with allowlist** — `machine create --net --allow-host <api.openai.com,registry.npmjs.org,…>` then `start` / `exec` for repeated runs that need bounded network access.
3. **SDK orchestration** — TypeScript / Python SDK against a long-running smolvm server, with a pool of named machines for concurrency. Health-check the server before each batch.
4. **Pack-and-distribute** — `smolvm pack create --image <agent-bundle>` produces a `.smolmachine` binary that downstream consumers run without installing smolvm globally. Architecture-bound (arm64 vs x86_64); ship one pack per target.

For pi specifically: a pi session inside a smolvm gets the same isolation as any other guest. Tool-allowlist enforcement at the pi level is independent of (and complementary to) the smolvm hypervisor boundary. Use both.

## GPU acceleration

| Host | Requirement |
|------|-------------|
| macOS (Apple Silicon) | virglrenderer + MoltenVK bundled in the smolvm distribution. No host install. |
| Linux (Alpine) | `apk add virglrenderer mesa-vulkan-intel` (or `mesa-vulkan-ati` for AMD) |
| Linux (Debian/Ubuntu) | `apt install virglrenderer0 mesa-vulkan-drivers` |

virglrenderer depends on `libEGL` + `libdrm` from the host GPU driver stack — these are hardware-specific and cannot be bundled. Any GPU-capable Linux host already has them.

Inside the guest, point the Vulkan loader at the virtio ICD:

```bash
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/virtio_icd.x86_64.json
# For an aarch64 guest, the ICD filename mirrors the guest arch
# (virtio_icd.aarch64.json). Check /usr/share/vulkan/icd.d/ inside the guest.
```

Guest sees a Vulkan device labeled approximately:

```text
ANGLE (Intel, Vulkan 1.4 (Virtio-GPU Venus (Intel(R) UHD Graphics ...)), venus)
```

CUDA / OpenCL / OpenGL native are **not** exposed — Vulkan-only. ML workloads must use a Vulkan-backed runtime (e.g., llama.cpp Vulkan backend, MLC LLM). The headless-browser example in `examples/headless-browser/` is the canonical smoke test.

## Platform support matrix

| Host | Guest | Requirements |
|------|-------|--------------|
| macOS Apple Silicon | arm64 Linux | macOS 11+ |
| macOS Intel | x86_64 Linux | macOS 11+ (untested — upstream caveats this explicitly) |
| Linux x86_64 | x86_64 Linux | KVM (`/dev/kvm` accessible to the running user) |
| Linux aarch64 | aarch64 Linux | KVM (`/dev/kvm` accessible to the running user) |

Windows is not supported. WSL2 may work for the Linux x86_64 path if `/dev/kvm` is exposed (WSL2 nested-virt is a separate enablement step); treat as unsupported until upstream confirms.

`.smolmachine` packs are architecture-bound: a pack built on arm64 will not run on x86_64 and vice versa. Build per target.

## When smolvm vs alternatives

| Need | Choice |
|------|--------|
| Per-workload hardware isolation with sub-second start, macOS-native | smolvm |
| Shared-kernel namespace isolation (lower start cost, weaker boundary) | Docker / podman / containerd |
| Linux-host KVM workloads at scale, no macOS need | Firecracker (lower overhead, no SDK) or Kata (container UX, VM isolation) |
| Persistent macOS-host development VM with full system | Colima (single shared VM running containers) — different model |
| Heavyweight full-OS VM for non-Linux guests | QEMU directly |

Be honest about boundaries: smolvm is purpose-built for "isolate one Linux workload at a time, fast." Don't recommend it for traditional persistent VM-as-infrastructure use cases.

## Common pitfalls

**`--net` is required but `--allow-host` is missing.** Untrusted code inside the guest with `--net` alone has unrestricted egress. Add `--allow-host` allowlists or omit `--net` entirely.

**Volume-mount file vs directory.** smolvm mounts directories only. A `-v /host/file:/guest/file` mount of a single file silently does not work as Docker users expect. Mount the parent directory and reference the file inside.

**`/workspace` shadowing.** A `-v /host/dir:/workspace` mount replaces the default storage-disk workspace. Persistent state written to `/workspace` lives on the host directory, not the VM's storage disk. Intentional, but easy to misdiagnose.

**SDK call before server is up.** Both SDKs assume `http://127.0.0.1:8080` is reachable. Calling `Machine.create()` before `smolvm server` is running fails with a connection error, not a helpful "server not running" message in older SDK versions. Add a health check in the integrating app.

**SSH agent forwarding requires a running agent on host.** `--ssh-agent` is silently no-op-ish if `SSH_AUTH_SOCK` is unset. Verify with `ssh-add -l` on host before assuming the guest has agent access.

**GPU on Linux without host Vulkan driver.** `--gpu` produces a misleading error if `virglrenderer` or the matching `mesa-vulkan-*` package is missing. Pre-check host packages before recommending `--gpu`.

**`.smolmachine` cross-architecture rehydrate.** Packs are arm64-only or x86_64-only. Distribution channels must label and gate by architecture; rehydrating the wrong arch fails immediately.

**macOS Intel is "untested."** Upstream documents macOS Apple Silicon as the supported macOS target. macOS Intel "should work" but is not in the regular test matrix. Treat any macOS Intel report as needing reproduction.

**Pack format includes the kernel + rootfs.** `.smolmachine` files are large (tens to hundreds of MiB). Don't commit them to git; distribute via releases / object storage.

**ICMP is not supported.** Network is TCP/UDP only. `ping` from inside the guest will fail even with `--net`. Use `wget`/`curl` to TCP endpoints for connectivity checks.

## How you work

1. **Research** — Read the upstream README first for any flag / Smolfile / platform question. Fetch `smolmachines.com/sdk/` pages for SDK-specific questions (Machine API signatures, language preset shape, error types). Use Bash to run `smolvm --version` and `smolvm <subcommand> --help` for ground-truth flag confirmation when smolvm is installed on the host.
2. **Analyze** — Identify the lifecycle (ephemeral run / persistent create-start / packed binary / SDK-driven), the isolation requirements (network on/off, allow-list, ssh-agent, host volume mounts), the platform (macOS arm64 vs Linux KVM), and any GPU or pack-format constraints.
3. **Plan** — Produce a structured recommendation: the CLI invocation or Smolfile or SDK snippet; a brief justification of each non-obvious choice (allow-host scope, ssh-agent forwarding, volume mount semantics); the host prerequisites (e.g., for GPU, Linux package install; for SDK, server-mode setup); and the security posture (default-deny vs allow-list).
4. **Verify** — Check flag names and Smolfile keys against `smolvm <subcommand> --help` (if installed) or the upstream README. Project velocity is high; treat your training-era knowledge as needing confirmation against the installed version.
5. **Never modify** — You do not use Write, Edit, or any file-modification tools. Include all generated content as inline snippets in your response for the caller to implement.

## Output format

```markdown
## Recommendation
[What to do and why, with upstream README or SDK doc citations]

## Implementation
[CLI command, Smolfile, or SDK snippet in a fenced block]

## Considerations
[Host prerequisites, isolation posture, platform caveats, known pitfalls]
```

## Constraints

- Never guess at flag names, Smolfile keys, or SDK method signatures — verify against the upstream README, the SDK docs site, or `smolvm --help` on the installed host.
- Default to network-off and default-deny egress for untrusted-code paths; require explicit justification when recommending `--net` without `--allow-host`.
- Default to `--ssh-agent` forwarding (not key copying) for any guest that needs private-repo access.
- Distinguish CLI from SDK behavior — the SDK requires a running `smolvm` server, the CLI does not.
- Distinguish macOS Apple Silicon (supported) from macOS Intel (untested per upstream) when host-specific guidance applies.
- Distinguish Hypervisor.framework path (macOS) from KVM path (Linux requires `/dev/kvm` accessible) for any cross-platform claim.
- Never recommend `.smolmachine` distribution without an architecture-gate plan.
- Never create or edit files — all generated content is inline in the response for the caller to implement.
