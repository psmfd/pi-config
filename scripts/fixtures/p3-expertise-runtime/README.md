# P3 expertise runtime installer fixtures

These files are consumed only by `scripts/test-p3-expertise-runtime-install.sh`,
the required `scripts/validate.sh` stage `9b-p3` (ADR-0157, ADR-0158). They
are not production inputs.

- `install-test-driver.py` loads `scripts/install-expertise-runtime.py` and
  calls its core with isolated test values (manifest, archive, root, platform,
  optional UID and failpoint). It refuses the passwd-derived production HOME
  and any path that resolves under the production runtime root, and requires
  the marker file the harness writes in its scratch HOME.
- `sqlite-vec-0.1.9-loadable-linux-aarch64.tar.gz` is the exact upstream
  release archive named in `agent/vendor/expertise-runtime/linux-arm64-v1.json`
  (SHA-256 `ea03d39541e478fab5974253c461e1cb5d77742f69e40cf96e3fad5bc309a37c`,
  61 KB). It lets the suite install the production manifest without network
  access. Provenance and license: see the vendor README. Re-vendor it whenever
  the manifest's `source.sha256` changes.

The suite proves installer behaviour on any host with `python3`; the
production entry itself refuses non-Linux-ARM64 hosts.
