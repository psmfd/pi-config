---
name: checkmarx-expert
description: 'Checkmarx One CLI reference for the checkmarx-expert subagent — SAST/SCA/IaC/secrets scans, auth, scan config, CI integration, results triage.'
disable-model-invocation: true
---

# Checkmarx One Expert

Read-only reference for Checkmarx One guidance — CLI tool usage, scan configuration, authentication, CI/CD integration, results management, and local scanning.

## Installation

The CLI binary is `cx` on Linux/macOS and `cx.exe` on Windows. Check if it is already installed:

```bash
# POSIX (Linux, macOS, WSL)
command -v cx >/dev/null 2>&1 && cx version

# PowerShell (Windows)
Get-Command cx -ErrorAction SilentlyContinue | ForEach-Object { cx version }
```

### Linux x64

```bash
curl -fsSL https://github.com/Checkmarx/ast-cli/releases/latest/download/ast-cli_linux_x64.tar.gz -o /tmp/cx.tar.gz
tar -xzf /tmp/cx.tar.gz -C /tmp
sudo install -m 0755 /tmp/cx /usr/local/bin/cx
rm /tmp/cx.tar.gz /tmp/cx
cx version
```

### Linux arm64

```bash
curl -fsSL https://github.com/Checkmarx/ast-cli/releases/latest/download/ast-cli_linux_arm64.tar.gz -o /tmp/cx.tar.gz
tar -xzf /tmp/cx.tar.gz -C /tmp
sudo install -m 0755 /tmp/cx /usr/local/bin/cx
rm /tmp/cx.tar.gz /tmp/cx
cx version
```

### macOS (Intel and Apple Silicon)

No native arm64 binary is published. The x64 binary runs under Rosetta 2 on Apple Silicon Macs.

```bash
curl -fsSL https://github.com/Checkmarx/ast-cli/releases/latest/download/ast-cli_darwin_x64.tar.gz -o /tmp/cx.tar.gz
tar -xzf /tmp/cx.tar.gz -C /tmp
sudo install -m 0755 /tmp/cx /usr/local/bin/cx
rm /tmp/cx.tar.gz /tmp/cx
cx version
```

If macOS Gatekeeper blocks execution ("developer cannot be verified"), run once:

```bash
xattr -d com.apple.quarantine /usr/local/bin/cx
```

### Windows (PowerShell)

```powershell
$InstallDir = "$env:LOCALAPPDATA\Programs\cx"
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$tmp = Join-Path $env:TEMP "cx-install.zip"
Invoke-WebRequest -Uri "https://github.com/Checkmarx/ast-cli/releases/latest/download/ast-cli_windows_x64.zip" -OutFile $tmp -UseBasicParsing
Expand-Archive -Path $tmp -DestinationPath $InstallDir -Force
Remove-Item $tmp

# Add to user PATH if not already present
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($userPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable('PATH', "$userPath;$InstallDir", 'User')
    $env:PATH += ";$InstallDir"
}
cx version
```

## CLI Command Reference

The Checkmarx One CLI binary is `cx` (Linux/macOS) or `cx.exe` (Windows). Top-level syntax: `cx <command> <subcommand> [flags]`.

### Core Commands

| Command | Purpose |
|---|---|
| `scan create` | Create and run a scan |
| `scan list` | List scans with filtering |
| `scan show --scan-id <id>` | Show scan details |
| `scan cancel --scan-id <id>` | Cancel a running scan |
| `scan sca-realtime -p <dir>` | Free local SCA scan (no account required) |
| `scan kics-realtime --file <file>` | Free local IaC scan via Docker/Podman (no account required) |
| `results show --scan-id <id>` | Retrieve scan results |
| `results exit-code --scan-id <id>` | Get exit code details |
| `project create --project-name <name>` | Create a project |
| `project list` | List projects |
| `triage update` | Update finding state/severity |
| `triage show` | Show triage history |
| `auth validate` | Validate authentication |
| `configure` | Interactive authentication setup |
| `configure set --prop-name <n> --prop-value <v>` | Set a config property |
| `configure show` | Display current config |

### Scan Types

Controlled via `--scan-types` flag (comma-separated):

| Type | Scanner | Flag value |
|---|---|---|
| Static Analysis | SAST | `sast` |
| Software Composition Analysis | SCA | `sca` |
| Infrastructure as Code | IaC Security (KICS) | `iac-security` |
| Container Security | Docker images/Dockerfiles | `container-security` |
| API Security | Swagger/OpenAPI files | `api-security` |
| Supply Chain Security | Secret detection, OSSF Scorecard | `scs` |

All enabled scanners run in parallel.

## Authentication

### API Key (simpler, inherits user permissions)

```bash
cx scan create --apikey <KEY> -s . --project-name myproject --branch main
```

- Generated from Checkmarx One portal: Settings > IAM > API Keys
- The CLI extracts base URL, auth URL, and tenant from the key automatically
- Expiration: 30-365 days
- Any license update (adding a scanner) invalidates all existing API keys

### OAuth Client (granular permissions)

```bash
cx scan create \
  --base-uri https://ast.checkmarx.net \
  --base-auth-uri https://iam.checkmarx.net \
  --tenant <TENANT> \
  --client-id <ID> \
  --client-secret <SECRET> \
  -s . --project-name myproject --branch main
```

- Created from portal: Settings > IAM > OAuth Clients
- `auth register` is deprecated — create clients through the UI only
- Requires `assign-project-all-groups` and `view-access` permissions

### Regional Base URLs

| Region | Server URL | IAM URL |
|---|---|---|
| US | `https://ast.checkmarx.net` | `https://iam.checkmarx.net` |
| US2 | `https://us.ast.checkmarx.net` | `https://us.iam.checkmarx.net` |
| EU | `https://eu.ast.checkmarx.net` | `https://eu.iam.checkmarx.net` |
| EU2 | `https://eu-2.ast.checkmarx.net` | `https://eu-2.iam.checkmarx.net` |
| DEU | `https://deu.ast.checkmarx.net` | `https://deu.iam.checkmarx.net` |
| ANZ | `https://anz.ast.checkmarx.net` | `https://anz.iam.checkmarx.net` |
| India | `https://ind.ast.checkmarx.net` | `https://ind.iam.checkmarx.net` |
| Singapore | `https://sng.ast.checkmarx.net` | `https://sng.iam.checkmarx.net` |

## Configuration

### Precedence (highest first)

1. CLI flags
2. Configuration file (`$HOME/.checkmarx/`)
3. Environment variables

### Key Environment Variables

| Variable | Purpose |
|---|---|
| `CX_APIKEY` | API key |
| `CX_BASE_URI` | Checkmarx One server URL |
| `CX_BASE_IAM_URI` | IAM server URL |
| `CX_TENANT` | Tenant name |
| `CX_CLIENT_ID` | OAuth client ID |
| `CX_CLIENT_SECRET` | OAuth client secret |
| `CX_CONFIG_FILE_PATH` | Override default config file location |
| `CX_HTTP_PROXY` | CX-specific proxy (overrides `HTTP_PROXY`) |

### Config as Code (`.checkmarx/config.yml`)

Place in repository root to override project-level settings:

```yaml
version: 1
checkmarx:
  scan:
    configs:
      sast:
        presetName: 'ASA Premium'
        fastScanMode: 'false'
        incremental: 'false'
        languageMode: 'multi'
        filter: '!*.java'
        recommendedExclusions: 'true'
      sca:
        filter: '!*.cpp'
        exploitablePath: 'true'
        lastSastScanTime: '10'
      kics:
        platforms: 'Ansible,Dockerfile,Terraform,Kubernetes'
```

## Local Scans

### SCA Realtime (no account required)

```bash
cx scan sca-realtime -p /path/to/project
```

- Free — no authentication needed
- Results returned as JSON to stdout
- Does not sync to Checkmarx One account
- Requires package managers installed locally

### IaC/KICS Realtime (no account required)

```bash
cx scan kics-realtime --file /path/to/file.tf --engine docker
```

- Free — no authentication needed
- Requires Docker or Podman running
- Supports: Ansible, ARM, CloudFormation, Dockerfile, Helm, Kubernetes, Terraform, and more

## Local Scan Security

Local scans (`sca-realtime`, `kics-realtime`) execute on developer or CI/CD infrastructure. SCA local resolution invokes package manager tooling (`npm`, `pip`, `gradle`, `go`) which can execute arbitrary code from malicious build files (e.g., `package.json` lifecycle scripts, `setup.py`, `build.gradle`). This attack class is proven — CVE-2022-40764 and CVE-2022-24441 demonstrated remote code execution via Snyk CLI during dependency resolution of crafted projects.

### Prefer Remote Scans When Possible

Cloud-based `cx scan create --scan-types sca` uploads manifests to Checkmarx for server-side dependency resolution. This eliminates the local code execution vector entirely because package manager tooling never runs on your infrastructure.

| Aspect | Remote (`cx scan create`) | Local (`sca-realtime`) |
|---|---|---|
| Dependency resolution | Server-side (Checkmarx infrastructure) | Local package managers |
| Code execution risk | None — manifests parsed, not executed | Package manager scripts execute locally |
| Account required | Yes | No |
| Results persistence | Synced to Checkmarx One project | JSON to stdout only |
| Network requirement | Outbound HTTPS to Checkmarx | Outbound HTTPS to package registries |

When a Checkmarx One account is available, always prefer `cx scan create --scan-types sca` over `cx scan sca-realtime` for scanning untrusted or third-party code.

For KICS/IaC scanning, the risk is lower because KICS evaluates IaC files using static Rego policies over parsed ASTs — it does not execute Terraform, Helm, or Ansible code. The primary risk surface is parser library bugs and the Docker/Podman containerization layer.

### Local Scan Hardening

When local scans are required (no account, air-gapped environments, or real-time IDE feedback):

**Pin the CLI version with hash verification:**

```bash
CX_VERSION="2.5.0"
CX_SHA256="<known-hash>"
curl -fsSL "https://github.com/Checkmarx/ast-cli/releases/download/v${CX_VERSION}/ast-cli_linux_x64.tar.gz" \
  -o /tmp/cx.tar.gz
echo "${CX_SHA256}  /tmp/cx.tar.gz" | sha256sum -c -
```

**Run SCA resolution in a sandboxed container:**

```bash
docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=256 \
  --memory=2g \
  --network=sca-egress-only \
  --user scanner \
  scanner-image:v1.0.0
```

Key protections: `--read-only` root filesystem, `--cap-drop=ALL`, `--pids-limit` (prevents fork bombs from malicious postinstall scripts), `--network` restricted to package registry egress only.

**Use `--ignore-scripts` for npm resolution.** The `cx` CLI SCA resolver does not pass `--ignore-scripts` by default. Control the resolution environment or strip lifecycle scripts before scanning untrusted projects.

**Use Podman for KICS realtime:**

```bash
cx scan kics-realtime --file /path/to/file.tf --engine podman
```

Podman is daemonless and rootless by default, avoiding the Docker socket mounting and Docker-in-Docker patterns that create container escape risks. On Debian 13, `apt install podman` provides Podman 5.x.

**Isolate scanning in CI/CD pipelines.** Run scans in a separate job with scoped credentials. Never pass pipeline access tokens or deployment credentials to the scanning environment.

## Thresholds and Break-Build

```bash
cx scan create -s . --project-name myapp --branch main \
  --threshold "sast-high=10; sca-high=5; iac-security-medium=20"
```

Threshold format: `<engine>-<severity>=<count>`. OR logic — any single threshold breach fails the build.

### Exit Codes

| Code | Meaning |
|---|---|
| 0 | All scanners completed successfully |
| 1 | Multiple scanners failed |
| 2 | SAST scanner failed |
| 3 | SCA scanner failed |
| 4 | IaC Security scanner failed |
| 5 | API Security scanner failed |

## CI/CD Integration

### GitHub Actions

Use the official `checkmarx/ast-github-action` from the GitHub Marketplace:

```yaml
- name: Checkmarx Scan
  uses: checkmarx/ast-github-action@latest
  with:
    base_uri: https://ast.checkmarx.net
    cx_tenant: ${{ secrets.CX_TENANT }}
    cx_client_id: ${{ secrets.CX_CLIENT_ID }}
    cx_client_secret: ${{ secrets.CX_CLIENT_SECRET }}
    project_name: ${{ github.repository }}
    branch: ${{ github.ref }}
    additional_params: '--scan-types sast,sca,iac-security --threshold "sast-high=0"'
```

Upload SARIF results to GitHub Security:

```yaml
- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v2
  with:
    sarif_file: cx_result.sarif
```

Requires `additional_params: "--report-format sarif --output-path ."` on the scan step.

### Azure DevOps Pipelines

Checkmarx provides a dedicated ADO plugin from the Azure DevOps Marketplace. Alternatively, use the CLI directly:

```yaml
steps:
  - script: |
      curl -L -o cx.tar.gz https://github.com/Checkmarx/ast-cli/releases/latest/download/ast-cli_linux_x64.tar.gz
      tar -xzf cx.tar.gz
      ./cx scan create -s $(Build.SourcesDirectory) \
        --project-name $(Build.Repository.Name) \
        --branch $(Build.SourceBranchName) \
        --base-uri $(CX_BASE_URI) \
        --tenant $(CX_TENANT) \
        --client-id $(CX_CLIENT_ID) \
        --client-secret $(CX_CLIENT_SECRET) \
        --scan-types sast,sca,iac-security
    displayName: 'Checkmarx One Scan'
```

Store credentials in Azure DevOps variable groups or pipeline variables (mark secrets as secret variables).

## File Filtering

| Flag | Scope | Works on git URLs? |
|---|---|---|
| `--file-filter` / `-f` | Global include/exclude | No |
| `--sast-filter` | SAST only | Yes |
| `--sca-filter` | SCA only | Yes |
| `--iac-security-filter` | IaC only | Yes |
| `--apisec-swagger-filter` | API Security only | Yes |

Use `!` prefix to exclude: `--sast-filter '!*.test.js,!*_test.go'`

The global `--file-filter` does not work on git repository URL sources — use scanner-specific filters instead.

## Results and Reporting

```bash
cx results show --scan-id <id> --report-format sarif --output-path ./reports
```

### Report Formats

| Format | Use |
|---|---|
| `json` / `json-v2` | Detailed per-finding (v2 matches UI format) |
| `sarif` | GitHub/Azure Security integration |
| `gl-sast` / `gl-sca` | GitLab Security Dashboard |
| `sonar` | SonarQube integration |
| `summaryConsole` | Quick terminal summary |
| `PDF` | Stakeholder reporting |
| `SBOM` | CycloneDX or SPDX bill of materials |

### Triage

```bash
cx triage update --scan-type sast --project-id <id> \
  --similarity-id <id> --state not_exploitable --severity low \
  --comment "False positive — test code only"
```

States: `to_verify`, `not_exploitable`, `proposed_not_exploitable`, `confirmed`, `urgent`

## Key Caveats

- Local SCA resolution (`sca-realtime`) executes untrusted package manager scripts — prefer cloud-based `cx scan create --scan-types sca` when an account is available, and sandbox local scans in hardened containers when it is not
- API keys are invalidated when the Checkmarx One license is updated (e.g., adding a new scanner)
- `--project-tags` overwrites existing tags — it is not additive
- `--project-groups` only works when creating a new project, not on existing ones
- `--scan-timeout` and `--async` are mutually exclusive
- SCA Resolver requires a local folder source — not zip or git URL
- IaC platform names in config-as-code are case-sensitive
- `--ignore-policy` requires `override-policy-management` permission
- Container image for CI (`checkmarx/ast-cli`) is subject to Docker Hub pull rate limits
