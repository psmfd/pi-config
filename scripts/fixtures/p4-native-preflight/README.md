# P4 native-preflight fixture

`probe-extension.mjs` is loaded by the pinned installed pi runtime from
`scripts/test-p4-native-preflight.sh`. It imports the private shared preflight
module and runs one isolated scenario per pi process. The evidence boundary it
implements is recorded in ADR-0159.

## Seam legs

The harness installs the exact P3 manifest and release archive below a private
temporary home. Each seam scenario clones that tree, alters metadata or bytes,
and supplies a matching test policy so the deep ELF and dynamic-ABI guards are
reached. The scenario then calls the exported `testExpertiseNativePreflight`
seam, which runs the same `preflightInstalledRuntime` the production entry
uses but takes no database and cannot call a loader. A rejected scenario
records its stable `P4_*` code with zero loader calls because the seam has no
loader, not because the production initializer was observed refusing to call
one. The Bun version and, on Linux, the SQLite version in the seam's runtime
facts are live, so a pi bump goes red on every lane; platform, glibc, and the
pi executable identity are synthetic.

`valid_spy`, `loader_failure`, `sql_loader_enabled`, and `sql_loader_state`
continue past the seam: the fixture calls the module's exported SQL-denial
probe (`testExpertiseSqlLoaderDenied`) and makes one `loadExtension()` call of
its own against a fake database. The single call counted there is the
fixture's. `loader_failure` shows one failed fixture call; the no-retry
property of the production initializer is proven only by
`production_loader_failure_retry`.

`wrong_owner_ancestor` bumps the expected uid and is refused at the real
home-directory ancestor. An unprivileged harness cannot chown, so the
runtime-tree owner checks need a second uid (#1108).

Every ELF mutation asserts the measured value at its byte offset before
overwriting it, so a re-vendored artifact fails with a re-measure message
instead of reaching a different guard.

## Production legs (Linux ARM64 only)

`production_load`, `production_loader_failure_retry`,
`production_sql_loader_enabled`, and `production_sql_loader_state` drive
`loadExpertiseNativeRuntime()` against the real passwd-home installation with
a real `bun:sqlite` connection. They prove that the exact artifact loads once
and reports sqlite-vec `v0.1.9`, that a failed attempt cannot be retried on the
same connection, and that both non-denied SQL-loader outcomes refuse before
any load. The harness runs them only when the runtime is already installed; it
never installs from a validator. Elsewhere they are skipped with a reason. The
ARM64 self-hosted lane runs them; the required `validate` job does not (#1107).

Under `GUARD_MUTATION_ID`, the harness runs the legs the registry names for
that mutation. The two loader guards with no portable behavioural leg
(exact-once call, latch order) are registered against structural source
checks; on ARM64 the matching production leg also runs and must go red.

## Scratch location

Every ancestor of the temporary home must satisfy the module's
trusted-ancestor rule (root- or self-owned, not group/world writable, no
symlink), otherwise each seam leg would refuse with `P4_PATH_WRITABLE` for an
environmental reason. The harness probes `P4_TEST_ROOT`,
`$XDG_CACHE_HOME/pi_config`, `~/.cache/pi_config`, and
`~/.local/share/agent-expertise` in that order, takes the first that passes,
and exits 2 naming the offending ancestor when none does.

The suite never passes a malformed artifact to Bun. A prior direct
truncated-ELF probe crashed Bun and is retained only as historical evidence in
`notes/local-expertise-a2-feasibility.md`.
