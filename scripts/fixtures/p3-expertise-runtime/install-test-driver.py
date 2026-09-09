#!/usr/bin/env python3
"""Isolated fixture driver for the P3 installer core; never a production entry."""

from __future__ import annotations

import argparse
import types
import os
import pwd
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--implementation", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--trusted-manifest", type=Path, action="append")
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--test-platform", required=True)
    parser.add_argument("--test-uid", type=int)
    parser.add_argument("--failpoint", choices=["after-stage", "after-publish"])
    args = parser.parse_args()

    home = Path(os.environ["HOME"]).resolve()
    account_home = Path(pwd.getpwuid(os.geteuid()).pw_dir).resolve()
    production_root = (account_home / ".local/share/agent-expertise/runtime").resolve(strict=False)
    if home == account_home:
        print("ERROR P3 fixture driver refuses the passwd-derived production HOME", file=sys.stderr)
        return 2
    try:
        args.root.resolve(strict=False).relative_to(production_root)
        print("ERROR P3 fixture driver refuses the production runtime root", file=sys.stderr)
        return 2
    except ValueError:
        pass
    marker = home / ".p3-runtime-test-root"
    if not marker.is_file():
        print("ERROR P3 fixture driver requires an isolated marked test HOME", file=sys.stderr)
        return 2
    # Compare canonical paths on both sides: HOME is resolved above, and the
    # scratch tree may sit behind a symlink (macOS /tmp and /var/folders do).
    try:
        args.root.resolve(strict=False).relative_to(home)
        args.archive.resolve(strict=False).relative_to(home)
    except ValueError:
        print("ERROR P3 fixture root and archive must remain under the isolated test HOME", file=sys.stderr)
        return 2
    fixture_manifest = (args.implementation.resolve().parent.parent / "agent/vendor/expertise-runtime/linux-arm64-v1.json")
    trusted_manifests = args.trusted_manifest or [args.manifest]
    for manifest in [args.manifest, *trusted_manifests]:
        manifest_under_home = True
        try:
            manifest.resolve(strict=False).relative_to(home)
        except ValueError:
            manifest_under_home = False
        if not manifest_under_home and manifest.resolve() != fixture_manifest:
            print("ERROR P3 fixture manifest is outside the isolated fixture inputs", file=sys.stderr)
            return 2

    module = types.ModuleType("p3_runtime_installer")
    module.__file__ = str(args.implementation)
    try:
        source = args.implementation.read_text(encoding="utf-8")
        exec(compile(source, str(args.implementation), "exec"), module.__dict__)
    except (OSError, UnicodeError, SyntaxError) as exc:
        print(f"ERROR cannot load the P3 installer implementation: {exc}", file=sys.stderr)
        return 2
    try:
        return module.install_runtime(
            manifest_path=args.manifest,
            trusted_manifest_paths=trusted_manifests,
            root=args.root,
            cache_root=home / ".cache/p3-runtime-test",
            observed_platform=args.test_platform,
            trusted_anchor=home,
            prohibited_roots=[production_root],
            archive_override=args.archive,
            failpoint=args.failpoint,
            expected_uid=args.test_uid,
        )
    except module.InstallFailure as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return exc.code
    except OSError as exc:
        print(f"ERROR unexpected filesystem error: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
