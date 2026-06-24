# pi_config nvm pin

Pinned to **nvm v0.40.4** (released 2026-01-29).

Per [ADR-0010](../../../adrs/0010-setup-install-trust-posture.md). The companion runtime-binary pin for pi lives in [`../pi/`](../pi/) per [ADR-0009](../../../adrs/0009-pi-runtime-acquisition-strategy.md); the two follow the same layout and bump procedure.

## What's here

- [`VERSION`](VERSION) — the upstream nvm release tag (e.g. `v0.40.4`). One line, included leading `v`. Consumed by `scripts/lib/install-helpers.sh` to build the install-script URL.
- [`CHECKSUMS`](CHECKSUMS) — `sha256  install.sh`. One line. Computed at pin time against the response body of `https://raw.githubusercontent.com/nvm-sh/nvm/<VERSION>/install.sh`. Verified at every `setup.sh` invocation that needs to install nvm.
- [`README.md`](README.md) — this file.

The nvm installer is not redistributed. We fetch the upstream `install.sh` over HTTPS, verify against the pinned sha256, and execute it. The pinned hash is the trust boundary.

## Consumption

`scripts/lib/install-helpers.sh` exposes `ih_ensure_nvm` which:

1. SKIPs if `~/.nvm/nvm.sh` is already present (nvm is per-user, no version check beyond presence — re-pinning a newer nvm does not auto-upgrade installed instances).
2. Otherwise downloads the pinned `install.sh`, verifies sha256, and runs it via `bash` (no `sudo`).
3. Sources the freshly-installed `~/.nvm/nvm.sh` into the current shell so subsequent `ih_ensure_node` calls can drive nvm directly.

`setup.sh` calls `ih_ensure_nvm` from §1 unless `PI_CONFIG_SKIP_DEPS=1` is set.

## Bump procedure

Mirrors the [ADR-0009 § Bump procedure](../../../adrs/0009-pi-runtime-acquisition-strategy.md#bump-procedure) verbatim for the pi pin; if the two diverge this section is the bug.

```sh
# 1. Pick the new tag.
NEW_TAG=v0.40.5

# 2. Verify the install.sh exists at that tag.
curl -fsS -o /dev/null https://raw.githubusercontent.com/nvm-sh/nvm/$NEW_TAG/install.sh && echo OK

# 3. Refresh CHECKSUMS from the upstream response body.
printf '%s  install.sh\n' \
  "$(curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/$NEW_TAG/install.sh | sha256sum | awk '{print $1}')" \
  > agent/vendor/nvm/CHECKSUMS

# 4. Update VERSION.
echo "$NEW_TAG" > agent/vendor/nvm/VERSION

# 5. Smoke test.
scripts/lib/install-helpers.sh --self-test

# 6. (No subagent re-pair concern; nvm is independent of the pi/subagent
#    vendor pair.)

# 7. Validate, then PR.
scripts/validate.sh
git commit -m "chore(vendor): bump nvm to $NEW_TAG"
```

Step 2 may seem trivial (nvm has never moved `install.sh`), but the cost is one HTTP HEAD and the benefit is catching a hypothetical relocation at bump time rather than as a contributor-facing setup.sh failure.

## License

nvm is MIT-licensed (see [nvm-sh/nvm LICENSE.md](https://github.com/nvm-sh/nvm/blob/master/LICENSE.md)). We do not redistribute the installer or any nvm code; we fetch and execute it after sha256 verification.

## Threat model

Same as the pi vendor pin: a malicious PR landing a forged sha256 against a forged installer would defeat the gate. Mitigations:

- CODEOWNERS coverage on `agent/vendor/nvm/{VERSION,CHECKSUMS}` (see `/CODEOWNERS`).
- Branch protection on `main` (admin-enforced).
- Bump procedure step 3 fetches over the live network at bump time, so the hash recorded in `CHECKSUMS` is what upstream is actually serving at that moment.

Acceptable threat model for an MIT-licensed dev tool; mirrors ADR-0009.
