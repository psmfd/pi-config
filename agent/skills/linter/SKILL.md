---
name: linter
description: 'Multi-tool linter reference for the linter subagent — shellcheck, markdownlint, yamllint, dotnet format, helm lint, tflint, actionlint, ruff.'
disable-model-invocation: true
---

## Purpose

Multi-tool linting agent that discovers lintable files in the working directory, runs the appropriate linters, and produces a structured findings report. Supports auto-fix mode for tools that offer it. Lints only code we generate — filters out third-party and vendored code.

## Tool Catalog

| Tool | Target | Check installed | Install | Check-only | Auto-fix | Config file |
|------|--------|-----------------|---------|------------|----------|-------------|
| shellcheck | Bash/sh scripts | `command -v shellcheck` | `sudo apt install shellcheck` | `shellcheck <file>` | (none) | `.shellcheckrc` |
| markdownlint-cli2 | Markdown | `command -v markdownlint-cli2` | `npm install -g markdownlint-cli2` (or via nvm: `nvm use --lts && npm install -g markdownlint-cli2`) | `markdownlint-cli2 "**/*.md"` | `markdownlint-cli2 --fix "**/*.md"` | `.markdownlint-cli2.yaml` |
| yamllint | YAML | `command -v yamllint` | `pdm add --dev yamllint` or `pip install --user yamllint` | `yamllint .` | (none) | `.yamllint.yaml` |
| dotnet format | C# | `dotnet --version` | Bundled with .NET SDK — install from <https://dot.net> or `sudo apt install dotnet-sdk-10.0` | `dotnet format --verify-no-changes` | `dotnet format` | `.editorconfig` |
| helm lint | Helm charts | `command -v helm` | `curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 \| bash` | `helm lint ./chart --strict` | (none) | `.helmignore` |
| hadolint | Dockerfiles | `command -v hadolint` | `curl -L https://github.com/hadolint/hadolint/releases/latest/download/hadolint-Linux-x86_64 -o ~/.local/bin/hadolint && chmod +x ~/.local/bin/hadolint` | `hadolint Dockerfile` | (none) | `.hadolint.yaml` |
| terraform validate | Terraform | `command -v terraform` | `wget -O- https://apt.releases.hashicorp.com/gpg \| sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg && echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" \| sudo tee /etc/apt/sources.list.d/hashicorp.list && sudo apt update && sudo apt install terraform` | `terraform init -backend=false && terraform validate` | (none) | (none) |
| tflint | Terraform | `command -v tflint` | `curl -s https://raw.githubusercontent.com/terraform-linters/tflint/master/install_linux.sh \| bash` | `tflint --recursive` | (none) | `.tflint.hcl` |
| actionlint | GitHub Actions | `command -v actionlint` | `curl -s https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash \| bash -s -- -b ~/.local/bin` | `actionlint` | (none) | `.github/actionlint.yaml` |
| ruff | Python | `command -v ruff` | `pdm add --dev ruff` or `curl -LsSf https://astral.sh/ruff/install.sh \| sh` | `ruff check . && ruff format --check .` | `ruff check --fix . && ruff format .` | `pyproject.toml [tool.ruff]` |

Auto-fix capable tools: markdownlint-cli2 (`--fix`), dotnet format (omit `--verify-no-changes`), ruff (`--fix` + `format` without `--check`).

## Default Configurations

Industry-standard starting configs. Use when a project has no existing config for a tool. Never overwrite existing configs.

### shellcheck (`.shellcheckrc`)

```ini
shell=bash
source-path=SCRIPTDIR
```

No disabled rules — shellcheck defaults are industry standard.

### markdownlint (`.markdownlint-cli2.yaml`)

```yaml
config:
  default: true
  MD013: false          # line length — impractical for prose
  MD033: false          # inline HTML — needed for GitHub-flavored markdown
  MD041: false          # first line h1 — conflicts with frontmatter
ignores:
  - "node_modules/**"
  - ".venv/**"
  - "vendor/**"
  - "roles/**"
```

### yamllint (`.yamllint.yaml`)

```yaml
extends: default
ignore: |
  node_modules/
  .venv/
  vendor/
  roles/
rules:
  line-length:
    max: 120
  truthy:
    allowed-values: ['true', 'false', 'yes', 'no', 'on', 'off']
  document-start: disable
```

### dotnet (`.editorconfig` key rules)

```ini
[*.cs]
dotnet_analyzer_diagnostic.severity = warning
dotnet_style_qualification_for_field = false:warning
dotnet_style_qualification_for_property = false:warning
csharp_style_var_for_built_in_types = true:suggestion
csharp_style_var_when_type_is_apparent = true:suggestion
csharp_style_expression_bodied_methods = when_on_single_line:suggestion
csharp_prefer_braces = true:warning
dotnet_style_prefer_collection_expression = true:suggestion
```

### hadolint (`.hadolint.yaml`)

```yaml
failure-threshold: warning
ignore:
  - DL3008
trustedRegistries:
  - docker.io
  - ghcr.io
  - mcr.microsoft.com
```

### tflint (`.tflint.hcl`)

```hcl
config {
  format = "compact"
  call_module_type = "local"
}
plugin "terraform" {
  enabled = true
  preset  = "recommended"
}
```

### ruff (`pyproject.toml`)

```toml
[tool.ruff]
line-length = 120
exclude = [".venv", "venv", "__pypackages__", "node_modules", "vendor", "roles", "dist", "build"]

[tool.ruff.lint]
select = ["E", "F", "W", "I", "N", "UP", "B", "A", "SIM"]
# E=pycodestyle, F=pyflakes, W=warnings, I=isort, N=naming,
# UP=pyupgrade, B=bugbear, A=builtins, SIM=simplify
```

actionlint, helm lint, and terraform validate need no config — defaults are industry standard.

## Toolchain Management

- **Node/npm:** managed via nvm (latest LTS). Source nvm before npm globals: `. "$NVM_DIR/nvm.sh" && nvm use --lts`
- **Python:** PDM with UV backend for project-scoped tools (`pdm add --dev`). System-wide: `pip install --user` or standalone installers (e.g., ruff standalone)
- **Binary tools** (hadolint, actionlint, tflint): download to `~/.local/bin/` or `/usr/local/bin/`
- Only install tools when explicitly instructed. Default: check availability, report if missing with install commands, offer to install, proceed with available tools
- Skip tool checks entirely when no files of the relevant type are discovered (e.g., do not check for hadolint if no Dockerfiles exist). Only report missing tools that would have been used

## Exclusion Patterns

Exclude these directories from all linting — they contain third-party or generated code:

| Directory | Reason |
|-----------|--------|
| `node_modules/` | npm dependencies |
| `.venv/` / `venv/` | Python virtual environments |
| `__pypackages__/` | PDM/PEP 582 packages |
| `vendor/` | Vendored dependencies |
| `roles/` | Ansible Galaxy roles |
| `.git/` | Version control |
| `bin/` / `obj/` | .NET build output |
| `.terraform/` | Terraform provider cache |
| `dist/` / `build/` | Build artifacts |

### Per-tool exclusion mechanisms

| Tool | Mechanism |
|------|-----------|
| shellcheck | `find` with `-prune` (no config-based exclusion) |
| markdownlint-cli2 | `ignores:` in `.markdownlint-cli2.yaml` or `!dir/**` CLI args |
| yamllint | `ignore:` in `.yamllint.yaml` (gitignore-style) |
| dotnet format | `--exclude` CLI flag |
| helm lint | Per-chart `.helmignore`; loop over `Chart.yaml` directories |
| hadolint | `find` with `-prune` for directory filtering |
| terraform validate | Per-module invocation; `find` to locate modules |
| tflint | `# tflint-ignore-file` per file; `--chdir` to target |
| actionlint | Auto-scoped to `.github/workflows/` |
| ruff | `exclude = [...]` in `[tool.ruff]` |

For tools without config-based exclusion, use `find` with `-prune`:

```bash
find . \
  -not \( -path '*/node_modules' -prune \) \
  -not \( -path '*/.venv' -prune \) \
  -not \( -path '*/venv' -prune \) \
  -not \( -path '*/__pypackages__' -prune \) \
  -not \( -path '*/vendor' -prune \) \
  -not \( -path '*/roles' -prune \) \
  -not \( -path '*/.git' -prune \) \
  -not \( -path '*/bin' -prune \) \
  -not \( -path '*/obj' -prune \) \
  -name '*.sh' \
  -exec shellcheck {} +
```

## File Discovery

Find lintable files by:

- **Extension:** `**/*.sh`, `**/*.md`, `**/*.yaml`, `**/*.yml`, `**/*.tf`, `**/*.py`, `**/*.cs`
- **Name:** `**/Dockerfile*`, `**/Chart.yaml`, `.github/workflows/*.yml`
- **Shebang:** grep for `#!/bin/bash`, `#!/usr/bin/env bash`, `#!/bin/sh` in extensionless files

Always apply exclusion patterns before passing files to linters.

## Output Format

```markdown
## Lint Report

### shellcheck (3 files, 2 findings)
- WARN SC2086: path/to/script.sh:12 — Double quote to prevent globbing
- ERROR SC2034: path/to/script.sh:25 — VAR appears unused

### markdownlint (15 files, 0 findings)
(clean)

## Missing Tools

The following linters are not installed. To install, run the commands below:

| Tool | Install command |
|------|-----------------|
| hadolint | `curl -L https://github.com/hadolint/hadolint/releases/latest/download/hadolint-Linux-x86_64 -o ~/.local/bin/hadolint && chmod +x ~/.local/bin/hadolint` |

These tools were skipped. Re-run after installing to get full coverage.

Would you like me to install any of these tools?

## Summary
| Tool | Files | Findings | Status |
|------|-------|----------|--------|
| shellcheck | 3 | 2 | WARN |
| markdownlint | 15 | 0 | PASS |
| hadolint | - | - | SKIP |
Total: 5 tools ran, 2 findings, 1 skipped
```

In auto-fix mode, append a fix summary:

```markdown
## Fixes Applied
| Tool | Files fixed | Findings before | Findings after |
|------|-------------|-----------------|----------------|
| ruff | 4 | 12 | 0 |
| markdownlint | 2 | 5 | 1 |
```
