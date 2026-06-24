---
description: Standardize output format, exit codes, and summary blocks for scripts in this repo
---

# Script Output Conventions

This is the **target convention for new scripts** authored in this repo or for downstream projects when no project-specific convention exists. One existing script in this repo — `scripts/validate.sh` — predates this rule and uses a simpler pattern documented at the bottom of this file as an accepted alternative; retrofitting it is out of scope. `setup.sh` originally used a different alternative pattern but was retrofitted to this rule in #112 and now follows the labelled convention below.

## Output Labels

Scripts that report check results, test outcomes, or operational status use these fixed-width labels. The label column is 6 characters wide, left-aligned, followed by a space.

| Label | Format | Use |
|---|---|---|
| `OK` | `OK    [name] message` | Check or test passed |
| `SKIP` | `SKIP  [name] message` | Precondition not met, gracefully skipped |
| `WARN` | `WARN  [name] message` | Non-fatal issue, does not affect exit code |
| `INFO` | `INFO  message` | Informational output, no bracket label |
| `ERROR` | `ERROR [name] message` | Fatal issue, increments error counter |

### Label Rules

- **Bracket labels** (`[name]`) identify the specific check or test. Use them with `OK`, `SKIP`, `WARN`, and `ERROR`. Omit for `INFO`.
- **Names** are short, lowercase, hyphenated identifiers (e.g. `[agent-catalog]`, `[frontmatter]`, `[skill-description]`).
- `ERROR` output goes to stderr. All other labels go to stdout.
- Verbose or debug detail uses an indented format: 6 spaces followed by detail text. Only print when a `--verbose` flag is active.

## Output Helpers

Scripts define helper functions for consistent formatting:

```bash
ok()    { echo "OK    [$1] $2"; }
skip()  { echo "SKIP  [$1] $2"; }
warn()  { echo "WARN  [$1] $2"; }
info()  { echo "INFO  $*"; }
err()   { echo "ERROR [$1] $2" >&2; }
detail(){ if $VERBOSE; then echo "      $*"; fi; }
```

Counter increments use the `((counter++)) || true` pattern to prevent `set -e` abort when incrementing from zero.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | All checks passed (warnings are informational only) |
| `1` | One or more errors found |
| `2` | Environment or precondition failure (missing env vars, missing dependencies, missing tools the script depends on) |

## Summary Block

Scripts that run multiple checks or tests end with a summary block:

```text
==================================
PASS — 0 errors, 2 warnings
```

or

```text
==================================
FAIL — 3 errors, 1 warning
```

The summary line uses `PASS` when `error_count` is zero and `FAIL` otherwise. Include both error and warning counts. Exit with code 1 on `FAIL`, code 0 on `PASS`.

## Script Header

New scripts include:

```bash
#!/usr/bin/env bash
set -euo pipefail
```

`set -e` (errexit) is the default. Scripts that deliberately count errors rather than abort on first failure may use `set -uo pipefail` (no `-e`) and increment an `errors` counter — this is the pattern `scripts/validate.sh` uses, and is an accepted alternative. Document the choice in a header comment.

All scripts include a comment block documenting usage and exit codes, following the pattern in `scripts/validate.sh`.

## Existing-script patterns (accepted alternatives)

`scripts/validate.sh` (pre-dating this rule):

- Uses lowercase `ok` (verbose-only by design — a passing check is the silent default), uppercase `WARN` and `ERROR`. No bracket-label name column.
- Summary block: `PASS — N error(s), N warning(s), N check(s) ok` (includes a `checks` total).
- Uses `set -uo pipefail` with manual error counting (see `set -e` note above).

The pattern is accepted because it predates this rule and the divergence is intentional for its context. New scripts should use the labelled convention above unless they have an equally specific reason to diverge — in which case, document the reason in the script's header comment.

`setup.sh` was retrofitted to the labelled convention in #112; its prior "indented `ok:`/`warn:`/`error:` sub-step" pattern is no longer in use anywhere in the repo.

## When this rule applies

- Any shell script created or edited under this repo's `scripts/`, `hooks/`, or `setup.sh`.
- Scripts authored for downstream projects when no project-specific convention exists. Project conventions take precedence.

## When this rule does not apply

- Scripts in downstream projects with their own established output conventions.
- One-liner or trivial scripts where structured output adds no value.
- Scripts that produce machine-readable output only (JSON, CSV) with no human-facing status — those follow the data format's own conventions.
