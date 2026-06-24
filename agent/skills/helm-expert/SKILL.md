---
name: helm-expert
description: 'Helm 3 reference for the helm-expert subagent — chart authoring, values merge, hooks, template debugging, dependencies, releases, helm diff validation.'
disable-model-invocation: true
---

# Helm Expert

Read-only reference for Helm guidance — values merge semantics, hooks, template debugging, dependency management, and release workflows.

## Values Merge Semantics

### Core Rule

Maps merge, lists replace. This is the single most common source of Helm deployment failures.

| Data type | Merge behavior | Surprise factor |
|---|---|---|
| Maps/objects | Deep merge (keys from both) | Expected |
| Lists/arrays | Complete replacement | High — original entries lost |
| Scalars | Override | Expected |

### Precedence (Lowest to Highest)

| Method | Precedence | Notes |
|---|---|---|
| Chart `values.yaml` | Lowest | Default values |
| Subchart `values.yaml` | Low | Subchart defaults |
| `-f first-file.yaml` | Medium | Left-to-right ordering |
| `-f second-file.yaml` | Higher | Overrides previous `-f` |
| `--set key=value` | Higher than all `-f` | — |
| `--set-string key=value` | Same as `--set` | Forces string type |
| `--set-json key='{"a":1}'` | Same as `--set` | Allows structured values |

### Special Operations

- `--set key=null` removes a key entirely (not empty map)
- `--set-file key=path` injects file contents as a string value

### Subchart Values Scoping

Values for subcharts are scoped under a key matching the subchart name (or alias). The subchart sees `auth.enabled`, not `redis.auth.enabled`.

`global.*` is the exception — accessible from any chart in the dependency tree.

## Values Layering

### Recommended Pattern

```text
chart/
  values.yaml              # Defaults (never environment-specific)
  values-base.yaml         # Shared overrides across all environments
  values-dev.yaml          # Development-specific
  values-staging.yaml      # Staging-specific
  values-production.yaml   # Production-specific
```

### Ordering Rule

`-f` files apply left to right. Last file wins for conflicting keys. `--set` always wins over `-f`.

```bash
helm upgrade --install myapp ./chart \
  -f chart/values-base.yaml \
  -f chart/values-production.yaml \
  --set image.tag=abc123
```

## Helm Hooks

### Hook Types

| Annotation value | When it runs |
|---|---|
| `pre-install` | Before any release resources are created |
| `post-install` | After all release resources are created |
| `pre-upgrade` | Before any upgrade resources are updated |
| `post-upgrade` | After all upgrade resources are updated |
| `pre-delete` | Before any release resources are deleted |
| `post-delete` | After all release resources are deleted |
| `pre-rollback` | Before a rollback |
| `post-rollback` | After a rollback |
| `test` | When `helm test` is run |

### Hook Annotations

```yaml
metadata:
  annotations:
    "helm.sh/hook": pre-upgrade
    "helm.sh/hook-weight": "5"
    "helm.sh/hook-delete-policy": before-hook-creation
```

### Weight Ordering

Hooks execute in weight order (ascending, as strings). Within the same weight, order is not guaranteed. Use weights to sequence dependent hooks.

### Deletion Policies

| Policy | Behavior |
|---|---|
| `before-hook-creation` | Delete previous hook resource before running new one |
| `hook-succeeded` | Delete after success |
| `hook-failed` | Delete after failure |

### The `hook-failed` Gap

If a hook has no deletion policy and fails, the resource stays in the cluster in a failed state. The next `helm upgrade` fails because the resource already exists. Use `before-hook-creation` as default to avoid accumulation.

### Hook Resource Lifecycle

Hook resources are NOT managed by `helm upgrade`. They are separate from the release's resource set. `helm get manifest` does not show them — use `kubectl get` instead.

## Template Debugging

### Rendering Commands

| Command | Behavior |
|---|---|
| `helm template myrelease ./chart` | Render all templates locally |
| `helm template -s templates/deploy.yaml` | Render specific template |
| `--dry-run=client` | Local render, no server (fast) |
| `--dry-run=server` | Server-side validation (catches schema errors) |

### Debugging Techniques

| Technique | Use |
|---|---|
| `{{ .Values.x \| toYaml }}` | Inspect a value |
| `{{ required "msg" .Values.x }}` | Fail if value missing |
| `{{ lookup "v1" "Secret" .Release.Namespace "name" }}` | Query cluster state |
| `{{ fail "reason" }}` | Force template failure |

### `lookup` Trap

`lookup` returns an empty dict during `helm template` and `--dry-run=client` because there is no cluster. Templates using `lookup` must handle the empty case.

### Whitespace Control

```yaml
{{- .Values.name }}     # Trim left
{{ .Values.name -}}     # Trim right
{{- .Values.name -}}    # Trim both
```

Incorrect whitespace trimming is the most common cause of invalid YAML output from templates.

## Chart Structure

```text
mychart/
  Chart.yaml              # Metadata (required)
  Chart.lock              # Dependency lock
  values.yaml             # Defaults
  charts/                 # Dependency charts
  templates/              # Go templates
    _helpers.tpl          # Partials
    NOTES.txt             # Post-install notes
    tests/                # Test resources
  crds/                   # CRDs (installed before templates)
  .helmignore             # Exclude from packaging
```

### Chart.yaml v2

```yaml
apiVersion: v2                    # Required for Helm 3
name: mychart
type: application                 # "application" or "library"
version: 0.1.0                    # Chart version (SemVer)
appVersion: "1.0.0"               # Application version (informational)
```

### Chart Types

| Type | Behavior |
|---|---|
| `application` (default) | Installed as a release, contains templates |
| `library` | Reusable helpers only, cannot be installed directly |

## Dependency Management

### Commands

| Command | Purpose |
|---|---|
| `helm dependency update ./chart` | Download dependencies from Chart.yaml |
| `helm dependency list ./chart` | List current dependencies |
| `helm dependency build ./chart` | Rebuild from Chart.lock |

### Condition vs Tags

```yaml
dependencies:
  - name: redis
    condition: redis.enabled       # Single boolean toggle
    tags:
      - cache                      # Group toggle via tags.cache
```

Condition takes precedence over tags when both are set.

### Repository Types

| Type | Format |
|---|---|
| OCI registry | `oci://registry-1.docker.io/bitnamicharts` |
| HTTP repository | `https://charts.bitnami.com/bitnami` |
| Local path | `file://../mylib` |

### Aliases

Use `alias` to install the same chart multiple times with different configurations. Values scope under the alias name.

## Release Management

### Idempotent Install/Upgrade

```bash
helm upgrade --install myrelease ./chart \
  -f values-prod.yaml \
  --namespace myns \
  --create-namespace
```

### `--atomic` Rollback-on-Failure

`--atomic` sets `--wait` implicitly. If the release fails within the timeout, Helm rolls back automatically. Without it, a failed upgrade leaves the release in `failed` state.

### `--wait` Timeout

Waits until all resources are ready. Default timeout: `5m0s`. Customize with `--timeout`.

### Rollback Limitations

- Reverts manifests and values to a previous revision
- Does NOT rollback database migrations, config changes, or hook side effects
- `helm rollback myrelease 3` targets revision 3 specifically

## `helm diff` Workflow

### Plugin Commands

```bash
# Compare current release with proposed upgrade
helm diff upgrade myrelease ./chart -f values-prod.yaml

# Compare specific revisions
helm diff revision myrelease 3 5

# Suppress secrets in output
helm diff upgrade myrelease ./chart --suppress-secrets
```

### Comparison Semantics

`helm diff` compares against the LAST SUCCESSFUL release, not the current cluster state. Resources modified via `kubectl edit` will not appear in the diff but will be overwritten by the upgrade.

### vs `helm template` + Manual Diff

- `helm diff upgrade` compares against live release — handles three-way merge correctly
- `helm template` renders locally — requires manual diff against last applied manifest
