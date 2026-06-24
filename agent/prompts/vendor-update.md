---
name: vendor-update
description: Vendor update workflow — inspect current pins, declare scope, follow docs/vendor-updates.md, validate, and review behavior-changing bumps.
---

# /vendor-update

Use this workflow to update or re-audit vendored dependencies in this repository.

Canonical runbook: [`docs/vendor-updates.md`](../../docs/vendor-updates.md).

## Required inputs

Before editing, identify:

- Vendored surface(s)
- Target upstream version or tag
- Change type:
  - pure version bump
  - re-audit only
  - policy/process change

If any input is missing, inspect the repo and ask only for the minimum clarification needed.

## Workflow

1. Read [`docs/vendor-updates.md`](../../docs/vendor-updates.md).
2. Inspect current repo state:
   - `git status --short`
   - current `VERSION` and `CHECKSUMS` files for the selected vendor surface(s)
   - relevant vendor `README.md` files
   - governing ADR links named by the guide
3. Confirm scope:
   - vendored surface(s)
   - target upstream version/tag
   - pure bump vs re-audit vs policy/process change
   - in-scope docs and out-of-scope follow-ups
4. Verify upstream release assets or source installer before editing.
5. Surface checksum trust posture from the guide, especially when no independent upstream checksum or signature exists.
6. Present or confirm the implementation plan and documentation-impact classification.
7. File or reuse follow-up issues before edits when the bump reveals out-of-scope work.
8. Update the minimum required files.
9. Run item-specific validation from the guide.
10. Run `scripts/validate.sh`.
11. Run `/review` when source code, extension code, runtime behavior, or install behavior changes.
12. Summarize validation, patch decisions, ADR impact, and follow-ups.

## Constraints

- Do not duplicate the guide's validation matrix in this prompt; link to the guide instead.
- Do not update `VERSION` without the corresponding `CHECKSUMS` change for checksum-pinned vendors.
- Do not treat archived `docs/archive/smolvm/` material as a live vendored item.
- Do not create an ADR for a routine bump unless vendor strategy, trust posture, install policy, or architecture changes.
- Keep unrelated local changes out of the vendor-update PR.

## Output expectations

At completion, report:

- changed files
- target upstream version/tag
- validation commands and results
- local patch retain/drop decisions, if `agent/extensions/subagent/` changed
- ADR decision: updated, newly created, or not needed with reason
- follow-up issues filed or reused
