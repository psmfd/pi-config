---
name: shell-expert
description: 'Shell scripting reference for the shell-expert subagent — Bash/Zsh/POSIX sh compatibility, coreutils, idioms, pitfalls, cross-platform, process control.'
disable-model-invocation: true
---

# Shell Expert

Read-only reference for shell scripting guidance — compatibility matrices, tooling pitfalls, security patterns, idioms, and cross-platform strategies.

## POSIX vs Bash vs Zsh Compatibility

### Feature Availability Matrix

| Feature | POSIX sh | Bash | Zsh |
|---|---|---|---|
| Indexed arrays | No | Yes (`declare -a`) | Yes |
| Associative arrays | No | Yes (4.0+, `declare -A`) | Yes |
| `[[ ]]` test syntax | No | Yes | Yes |
| Process substitution `<()` | No | Yes | Yes |
| Here-strings `<<<` | No | Yes | Yes |
| `local` keyword | No (use function scope) | Yes | Yes |
| `${var,,}` case conversion | No | Yes (4.0+) | No (use `${(L)var}`) |
| `${var^^}` case conversion | No | Yes (4.0+) | No (use `${(U)var}`) |
| `$'...'` ANSI-C quoting | No | Yes | Yes |
| Extended globs `@(a\|b)` | No | Yes (`shopt -s extglob`) | Yes (different syntax: `(a\|b)`) |
| `select` menu loops | No | Yes | Yes |
| `coproc` | No | Yes (4.0+) | Yes (`coproc` builtin) |
| `&>>` append redirect stderr+stdout | No | Yes (4.0+) | Yes |
| `read -p` prompt | No | Yes | No (use `read "?prompt"`) |
| Arithmetic `(( ))` | No | Yes | Yes |
| `typeset` / `declare` | No | `declare` preferred | `typeset` preferred |

### Portability Guidance

- Target POSIX sh when the script must run on any Unix (Alpine, busybox, FreeBSD, older macOS).
- Use `#!/usr/bin/env bash` only when Bash-specific features are required.
- The `local` keyword is widely supported but technically not POSIX — safe in practice for Bash and Zsh.
- `[[ ]]` is safer than `[ ]` (no word splitting, supports `=~` regex) but requires Bash/Zsh.
- Arithmetic: POSIX uses `$(( ))` for expansion only. Bash/Zsh `(( ))` also allows statements.

## Coreutils and Standard Tooling

### GNU vs BSD Differences

| Tool | GNU (Linux) | BSD (macOS) | Portable alternative |
|---|---|---|---|
| `sed -i` | `sed -i 's/a/b/'` | `sed -i '' 's/a/b/'` | Use `sed 's/a/b/' file > tmp && mv tmp file` |
| `grep -P` (PCRE) | Supported | Not available | Use `grep -E` (extended regex) |
| `find -exec {} +` | Supported | Supported (10.4+) | Safe on modern systems |
| `readlink -f` | Canonical path | Not available | Use `realpath` or `python -c` fallback |
| `stat` format | `stat -c '%s' file` | `stat -f '%z' file` | Use `wc -c < file` for size |
| `date` formatting | `date -d '2024-01-01'` | `date -j -f '%Y-%m-%d' '2024-01-01'` | Use `date +%s` for epoch |
| `mktemp` | `mktemp` (no args ok) | `mktemp` (requires template on older) | `mktemp /tmp/prefix.XXXXXX` |
| `sort -V` (version sort) | Supported | Not available (macOS 12+) | Avoid or provide fallback |
| `xargs -r` (no-run-if-empty) | Supported | Not available | Pipe through `grep -v '^$'` first |
| `cp -T` (no target dir) | Supported | Not available | Use explicit paths |

### Platform Detection

```sh
case "$(uname -s)" in
  Linux*)  platform=linux ;;
  Darwin*) platform=macos ;;
  CYGWIN*|MINGW*|MSYS*) platform=windows ;;
  FreeBSD*) platform=freebsd ;;
  *) platform=unknown ;;
esac
```

Prefer feature detection over platform detection when possible — test for the tool's existence with `command -v` rather than branching on OS name.

## Common Pitfall Patterns

### Word Splitting and Globbing

Unquoted variables undergo word splitting and glob expansion:

```sh
file="my file.txt"
cat $file        # WRONG — splits into "my" and "file.txt"
cat "$file"      # Correct

files="*.txt"
echo $files      # Expands globs — lists matching files
echo "$files"    # Literal string "*.txt"
```

**Rule:** Always double-quote variable expansions (`"$var"`, `"${var}"`, `"$@"`) unless you specifically intend splitting or globbing.

### Subshell Variable Scope

Pipes create subshells — variables set inside are lost:

```sh
count=0
echo "a b c" | while read -r word; do
  count=$((count + 1))       # Increments inside subshell
done
echo "$count"                # Prints 0, not 3
```

**Fixes:** Use process substitution (`while read -r word; do ... done < <(echo "a b c")`), a here-string, or restructure to avoid the pipe.

### `set -e` Subtleties

`set -e` (errexit) does NOT trigger on:

- Commands in `if` conditions, `while`/`until` conditions, or `&&`/`||` chains
- Commands in subshells when the subshell's exit status is tested
- Functions called from any of the above contexts

```sh
set -e
false || true    # Does NOT exit — || suppresses errexit
if false; then   # Does NOT exit — if condition
  echo "no"
fi
```

**Recommendation:** Use `set -euo pipefail` as a baseline, but do not rely on `set -e` as the sole error-handling mechanism. Check critical command exit codes explicitly.

### Pipeline Exit Codes

Without `pipefail`, a pipeline's exit code is the last command's exit code:

```sh
false | true     # Exit code 0 (true succeeds)
set -o pipefail
false | true     # Exit code 1 (false failed)
```

`pipefail` is not POSIX — it is supported by Bash, Zsh, and most modern shells.

### nftables Base Chain Verdict Scope

In nftables, an `accept` verdict in one base chain does not prevent evaluation by later-priority base chains registered on the same hook. From the [nftables wiki](https://wiki.nftables.org/wiki-nftables/index.php/Configuring_chains): "packets will traverse all of the chains within the scope of a given hook until they are either dropped or no more base chains exist." Only `drop` is terminal. This differs materially from iptables, where `ACCEPT` ends traversal within a table's chain.

**Practical impact on Debian 13.** libvirt's nftables backend registers chains at priority `-1` (before `inet filter forward` at priority `0`). Any base chain on the FORWARD hook with a `drop` policy — installed by Docker, ufw, or the default `/etc/nftables.conf` — evaluates after libvirt's `accept` and drops VM traffic. Setting `firewall_backend = "nftables"` in `/etc/libvirt/network.conf` does not fix this; it is the cause. Debian reverted the libvirt nftables backend to iptables as the default in `libvirt 10.10.0-4` ([Debian bug #1090355](https://bugs-devel.debian.org/cgi-bin/bugreport.cgi?bug=1090355)).

Diagnostics:

```bash
nft list chain inet filter forward    # inspect the chain with the DROP policy
nft list ruleset                      # enumerate all rules; identify table family/name
```

**Fix:** add an explicit `accept` for the bridge interface (or for conntrack-tracked return traffic) to the DROP-policy chain:

```bash
nft add rule inet filter forward iifname "virbr0" accept
nft add rule inet filter forward oifname "virbr0" accept
nft add rule inet filter forward ct state established,related accept
```

Changing the DROP chain's policy to `accept` is valid but broad. Setting libvirt's firewall backend to nftables on a system with Docker or ufw is not a fix.

**Rule:** Only `drop` is terminal in nftables. `accept` in a low-priority chain does not shield packets from a `drop` in a higher-priority-number chain on the same hook.

## Security Concerns

### Command Injection

Never pass untrusted input to `eval`, unquoted command substitution, or string-based command construction:

```sh
# DANGEROUS — user input interpreted as shell code
eval "echo $user_input"

# SAFE — input is data, not code
echo "$user_input"
```

**High-risk patterns:** `eval`, `source` with variable paths, `bash -c "$var"`, unquoted `$(command)` in arithmetic, `printf -v` with format from user input.

### Temporary Files

```sh
# WRONG — predictable path, race condition (symlink attack)
tmpfile="/tmp/myapp.tmp"

# CORRECT — unpredictable name, restrictive permissions
tmpfile=$(mktemp /tmp/myapp.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT
```

Always use `mktemp` for temporary files and directories. Always register a trap to clean up.

### Credential Handling

- Never embed credentials in scripts — use environment variables or credential files with `600` permissions.
- Avoid passing secrets via command-line arguments — they are visible in `ps` output. Use stdin, environment variables, or temp files with restrictive permissions.
- When reading secrets: `read -rs` suppresses echo.

### Signal Safety

Register cleanup traps for resources (temp files, lock files, child processes):

```sh
cleanup() {
  rm -f "$tmpfile" "$lockfile"
  kill "$bg_pid" 2>/dev/null
  wait "$bg_pid" 2>/dev/null
}
trap cleanup EXIT INT TERM
```

Trap `EXIT` for normal termination, `INT` for Ctrl-C, `TERM` for `kill`. `KILL` (signal 9) cannot be trapped.

## Shell Scripting Idioms

### Parameter Expansion Reference

| Syntax | Meaning |
|---|---|
| `${var:-default}` | Use `default` if `var` is unset or empty |
| `${var:=default}` | Assign `default` if `var` is unset or empty |
| `${var:+substitute}` | Use `substitute` if `var` IS set and non-empty |
| `${var:?error msg}` | Exit with error if `var` is unset or empty |
| `${#var}` | Length of `var` |
| `${var%pattern}` | Remove shortest match of `pattern` from end |
| `${var%%pattern}` | Remove longest match of `pattern` from end |
| `${var#pattern}` | Remove shortest match of `pattern` from start |
| `${var##pattern}` | Remove longest match of `pattern` from start |
| `${var/old/new}` | Replace first match (Bash/Zsh, not POSIX) |
| `${var//old/new}` | Replace all matches (Bash/Zsh, not POSIX) |

### Error Handling Pattern

```sh
#!/usr/bin/env bash
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -f "$config_file" ]] || die "Config file not found: $config_file"
```

### Here-Documents

```sh
# Variables expanded (unquoted delimiter)
cat <<EOF
Hello $USER, today is $(date)
EOF

# Variables NOT expanded (quoted delimiter)
cat <<'EOF'
Literal $USER and $(date) — no expansion
EOF

# Indented (tab-stripped with <<-)
if true; then
 cat <<-EOF
 Tabs stripped from body
 EOF
fi
```

### Array Patterns (Bash/Zsh)

```sh
# Declaration and iteration
files=("one.txt" "two.txt" "three.txt")
for f in "${files[@]}"; do
  echo "$f"
done

# Length and slicing
echo "${#files[@]}"          # Count: 3
echo "${files[@]:1:2}"       # Slice: "two.txt" "three.txt"

# Append
files+=("four.txt")
```

**Critical:** Always use `"${array[@]}"` (quoted) to preserve elements containing spaces.

## Cross-Platform Strategies

### Shebang Portability

| Shebang | Portability | Notes |
|---|---|---|
| `#!/bin/sh` | Universal | POSIX sh only — no Bash features |
| `#!/bin/bash` | Linux, most BSDs | Not at this path on all systems (NixOS, FreeBSD) |
| `#!/usr/bin/env bash` | Most portable for Bash | Relies on `env` at `/usr/bin/env` (near-universal) |
| `#!/usr/bin/env zsh` | Zsh systems | Same portability caveat as above |

### Feature Detection Pattern

```sh
# Prefer this over OS-based branching
if command -v realpath >/dev/null 2>&1; then
  canonical=$(realpath "$path")
elif command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1; then
  canonical=$(readlink -f "$path")
else
  canonical=$(cd "$(dirname "$path")" && pwd)/$(basename "$path")
fi
```

### Path Handling

- Use `"$(cd "$(dirname "$0")" && pwd)"` to resolve a script's own directory portably.
- Avoid relying on `$BASH_SOURCE` in POSIX scripts — it is Bash-specific.
- Normalize paths before comparison — trailing slashes, symlinks, and `..` segments cause false mismatches.

## Shell Configuration Load Order

### Bash

| Context | Files sourced (in order) |
|---|---|
| Login shell | `/etc/profile` → `~/.bash_profile` OR `~/.bash_login` OR `~/.profile` (first found) |
| Interactive non-login | `~/.bashrc` |
| Non-interactive (scripts) | `$BASH_ENV` (if set) |

**Common pattern:** `~/.bash_profile` sources `~/.bashrc` so that login shells also get interactive config:

```sh
# ~/.bash_profile
[[ -f ~/.bashrc ]] && source ~/.bashrc
```

### Zsh

| Context | Files sourced (in order) |
|---|---|
| Always | `~/.zshenv` |
| Login shell | `~/.zprofile` → `~/.zshrc` → `~/.zlogin` |
| Interactive non-login | `~/.zshrc` |
| Non-interactive (scripts) | `~/.zshenv` only |

**Key difference from Bash:** `~/.zshenv` runs for ALL Zsh invocations (including scripts). Keep it minimal — only truly universal env vars. Heavy setup goes in `~/.zshrc`.

### Decision Matrix

| "Where should I put this?" | Bash | Zsh |
|---|---|---|
| `PATH` and env vars (all contexts) | `~/.profile` or `~/.bash_profile` | `~/.zshenv` |
| Interactive config (aliases, prompt) | `~/.bashrc` | `~/.zshrc` |
| Login-only setup (ssh agent, motd) | `~/.bash_profile` | `~/.zprofile` |
| Completion setup | `~/.bashrc` | `~/.zshrc` |

## Process Management

### Signal Reference

| Signal | Number | Default action | Trappable | Common use |
|---|---|---|---|---|
| `SIGHUP` | 1 | Terminate | Yes | Terminal closed, daemon reload |
| `SIGINT` | 2 | Terminate | Yes | Ctrl-C |
| `SIGQUIT` | 3 | Core dump | Yes | Ctrl-\ |
| `SIGKILL` | 9 | Terminate | **No** | Force kill (last resort) |
| `SIGTERM` | 15 | Terminate | Yes | Graceful shutdown (`kill` default) |
| `SIGSTOP` | 19 | Stop | **No** | Pause process |
| `SIGCONT` | 18 | Continue | Yes | Resume stopped process |
| `SIGUSR1` | 10 | Terminate | Yes | Application-defined |
| `SIGUSR2` | 12 | Terminate | Yes | Application-defined |

### Job Control

```sh
command &              # Run in background, get PID in $!
wait "$!"              # Wait for specific background job
wait                   # Wait for all background jobs
jobs                   # List background jobs
fg %1                  # Bring job 1 to foreground
bg %1                  # Resume stopped job in background
disown %1              # Detach job from shell (survives shell exit)
```

### Background Process Patterns

```sh
# Run and wait with exit code
long_task &
pid=$!
wait "$pid"
status=$?
[[ $status -eq 0 ]] || echo "Task failed with $status"

# Survive logout
nohup long_task > /tmp/task.log 2>&1 &

# Cleanup on exit
pids=()
for i in 1 2 3; do
  subtask "$i" &
  pids+=($!)
done
trap 'kill "${pids[@]}" 2>/dev/null; wait' EXIT
for pid in "${pids[@]}"; do
  wait "$pid"
done
```

### Lock File Pattern

```sh
lockfile="/var/run/myapp.lock"

acquire_lock() {
  if ! mkdir "$lockfile" 2>/dev/null; then
    echo "Another instance is running" >&2
    exit 1
  fi
  trap 'rm -rf "$lockfile"' EXIT
}
```

Using `mkdir` is atomic on all filesystems — safer than checking and creating a file in two steps.

## Source Authority for Linux Packaging

When answering questions about what systemd units a package ships, their default enabled state, or distribution-level defaults, prefer upstream and primary sources over third-party blog posts and tutorials.

### Source Hierarchy

| Priority | Source | Example |
|---|---|---|
| 1 | Distribution packaging files | `debian/rules`, `debian/control` on Salsa (salsa.debian.org) |
| 2 | Package file lists | `dpkg -L <package>`, `rpm -ql <package>`, package tracker file lists |
| 3 | Distribution release notes and changelogs | Debian Release Notes, package changelogs (`apt changelog <pkg>`) |
| 4 | Man pages and upstream documentation | `man sshd_config`, upstream project docs |
| 5 | Blog posts and tutorials | Use only when primary sources are silent; cross-reference before citing |

### When This Matters

- **Systemd unit state** — which units a package installs and whether they are enabled by default is defined by `dh_installsystemd` invocations in `debian/rules`, not by blog post claims. Blog sources frequently confuse stock distribution behavior with cloud provider image customization.
- **Package defaults** — configuration file defaults, dependency chains, and post-install behavior are defined by the packaging scripts, not tutorials that may describe a different version or distribution.
- **Cloud provider divergence** — cloud images (AWS AMI, Hetzner, DigitalOcean) may enable, disable, or reconfigure services differently from stock distribution installs. Note when the answer may differ between stock and cloud-provisioned systems.

### Cross-Reference Rule

When a blog post or tutorial makes a claim with operational impact (e.g., "Debian 13 does not use ssh.socket") and it contradicts or is not supported by primary sources, flag the discrepancy. Do not present the blog claim as authoritative. State what the primary source says, then note the blog's contrary claim and the likely reason for the discrepancy (outdated information, different distribution, cloud image customization).

## CLI Exploration Strategy

When researching a CLI tool (e.g., via `--help`, man pages, or web search), scope the depth of exploration to avoid diminishing returns.

### Depth Tiers

| Tier | When to use | Approach |
|---|---|---|
| Quick | Answering a specific flag or subcommand question | Top-level `--help` only, or targeted man page section |
| Moderate | Building general knowledge of a tool | Top-level `--help` + 3–5 key subcommands that represent distinct functional areas |
| Exhaustive | Explicitly requested, or tool has highly irregular subcommand structure | Enumerate all subcommands — but still summarize patterns rather than dumping raw output |

### Default Approach (Moderate)

1. Run top-level `tool --help` to get the subcommand list and global flags
2. Identify 3–5 subcommands that cover the tool's primary functional areas (e.g., for `gh`: `issue`, `pr`, `run`, `repo`, `auth`)
3. Run `tool subcommand --help` for those key subcommands
4. Note shared patterns (common flags, consistent output formats, shared `--json`/`--jq` options)
5. Stop once patterns repeat — if three subcommands all share the same output flags, the fourth likely does too

### Stop Signals

- **Repeating flag patterns:** Once you see that most subcommands share the same global options (`--repo`, `--json`, `--jq`), further enumeration confirms what you already know
- **Consistent structure:** If every subcommand follows the same `list`/`view`/`create`/`edit`/`delete` pattern, document the pattern once rather than for each subcommand
- **Context budget:** If research output exceeds ~2,000 lines of help text, you are likely past the point of useful signal

### When to Go Exhaustive

- The caller explicitly requests comprehensive coverage
- The tool has known inconsistencies across subcommands (different flag names, incompatible output formats)
- You are generating a reference document that must be complete (e.g., building a SKILL.md for the tool)
