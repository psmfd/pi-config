#!/usr/bin/env python3
"""Install a digest-attested local-expertise runtime generation (A2/P3).

P3 installs bytes only. It deliberately does not parse ELF/ABI metadata, call
Bun's native loader, implement provider behavior, or install P5 executors.

Exit codes: 0 installed, selected, or revalidated; 1 a classified refusal
(digest, inventory, mode, owner, link, path, or selector check failed);
2 configuration or environment failure (manifest, host, prerequisites);
3 an unexpected filesystem error, never to be read as a refusal.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import platform
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn

SCHEMA_VERSION = 1
SELECTOR_SCHEMA_VERSION = 1
GENERATION_RE = re.compile(r"^v[0-9]+-linux-arm64-sqlite-vec-v[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
MODE_RE = re.compile(r"^0[67]00$")
TOP_KEYS = {"schemaVersion", "generation", "platform", "compatibility", "source", "files"}
PLATFORM_KEYS = {"os", "arch"}
COMPAT_KEYS = {"pi", "bun", "sqlite"}
SOURCE_KEYS = {"url", "asset", "sha256"}
FILE_KEYS = {"path", "archivePath", "sha256", "size", "mode", "role", "version"}


class InstallFailure(Exception):
    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


def info(message: str) -> None:
    print(f"INFO  {message}")


def ok(message: str) -> None:
    print(f"OK    {message}")


def skip(message: str) -> None:
    print(f"SKIP  {message}")


def fail(message: str, code: int = 1) -> NoReturn:
    raise InstallFailure(message, code)


def duplicate_rejecting_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"manifest contains duplicate key: {key}", 2)
        result[key] = value
    return result


def exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{label} must be an object", 2)
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        fail(f"{label} keys mismatch (missing={missing}, unknown={unknown})", 2)
    return value


def safe_relative_path(raw: Any, label: str) -> str:
    if not isinstance(raw, str) or not raw or "\\" in raw or "\x00" in raw:
        fail(f"{label} is not a safe POSIX relative path", 2)
    path = PurePosixPath(raw)
    if path.is_absolute() or raw != path.as_posix() or any(part in ("", ".", "..") for part in path.parts):
        fail(f"{label} is not a normalized relative path", 2)
    return raw


def canonical_manifest_bytes(manifest: dict[str, Any]) -> bytes:
    return (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(path: Path) -> tuple[dict[str, Any], bytes]:
    try:
        raw = path.read_text(encoding="utf-8")
        manifest = json.loads(raw, object_pairs_hook=duplicate_rejecting_object)
    except InstallFailure:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        fail(f"cannot read a valid UTF-8 JSON runtime manifest: {exc}", 2)

    manifest = exact_keys(manifest, TOP_KEYS, "manifest")
    if manifest["schemaVersion"] != SCHEMA_VERSION:
        fail("unsupported runtime manifest schemaVersion", 2)
    generation = manifest["generation"]
    if not isinstance(generation, str) or not GENERATION_RE.fullmatch(generation):
        fail("manifest generation is malformed", 2)

    target = exact_keys(manifest["platform"], PLATFORM_KEYS, "manifest.platform")
    if target != {"os": "linux", "arch": "arm64"}:
        fail("manifest platform must be exactly linux-arm64", 2)

    compatibility = exact_keys(manifest["compatibility"], COMPAT_KEYS, "manifest.compatibility")
    if not all(isinstance(compatibility[key], str) and compatibility[key] for key in COMPAT_KEYS):
        fail("manifest compatibility values must be non-empty strings", 2)

    source = exact_keys(manifest["source"], SOURCE_KEYS, "manifest.source")
    if not isinstance(source["url"], str) or not source["url"].startswith("https://github.com/asg017/sqlite-vec/releases/download/"):
        fail("manifest source URL is outside the pinned sqlite-vec release origin", 2)
    asset = safe_relative_path(source["asset"], "manifest.source.asset")
    if "/" in asset or not asset.endswith(".tar.gz"):
        fail("manifest source asset must be one tar.gz basename", 2)
    if not isinstance(source["sha256"], str) or not SHA256_RE.fullmatch(source["sha256"]):
        fail("manifest source digest is malformed", 2)

    files = manifest["files"]
    if not isinstance(files, list) or not files:
        fail("manifest files must be a non-empty array", 2)
    installed: set[str] = set()
    archived: set[str] = set()
    for index, raw_file in enumerate(files):
        entry = exact_keys(raw_file, FILE_KEYS, f"manifest.files[{index}]")
        installed_path = safe_relative_path(entry["path"], f"manifest.files[{index}].path")
        archive_path = safe_relative_path(entry["archivePath"], f"manifest.files[{index}].archivePath")
        if installed_path in installed or archive_path in archived:
            fail("manifest file paths must be unique", 2)
        installed.add(installed_path)
        archived.add(archive_path)
        if not isinstance(entry["sha256"], str) or not SHA256_RE.fullmatch(entry["sha256"]):
            fail(f"manifest.files[{index}].sha256 is malformed", 2)
        if not isinstance(entry["size"], int) or isinstance(entry["size"], bool) or entry["size"] <= 0:
            fail(f"manifest.files[{index}].size must be a positive integer", 2)
        if not isinstance(entry["mode"], str) or not MODE_RE.fullmatch(entry["mode"]):
            fail(f"manifest.files[{index}].mode must be 0600 or 0700", 2)
        if entry["role"] not in ("native-library", "executable", "data"):
            fail(f"manifest.files[{index}].role is unsupported", 2)
        if entry["role"] == "executable" and entry["mode"] != "0700":
            fail("executable manifest entries require mode 0700", 2)
        if entry["role"] != "executable" and entry["mode"] != "0600":
            fail("non-executable manifest entries require mode 0600", 2)
        if not isinstance(entry["version"], str) or not entry["version"]:
            fail(f"manifest.files[{index}].version must be a non-empty string", 2)

    expected_suffix = manifest["files"][0]["sha256"][:12]
    if not generation.endswith(f"-{expected_suffix}"):
        fail("manifest generation does not bind the first installed-file digest", 2)
    return manifest, canonical_manifest_bytes(manifest)


def generation_version(generation: str) -> int:
    match = re.match(r"^v([0-9]+)-", generation)
    if match is None:
        fail("generation name has no leading version", 2)
    return int(match.group(1))


def mode_of(metadata: os.stat_result) -> int:
    return stat.S_IMODE(metadata.st_mode)


def inspect_entry(path: Path, expected_type: str, expected_mode: int, uid: int, label: str) -> os.stat_result:
    try:
        metadata = path.lstat()
    except OSError as exc:
        fail(f"{label} cannot be inspected: {exc}")
    if stat.S_ISLNK(metadata.st_mode):
        fail(f"{label} must not be a symlink")
    if expected_type == "directory" and not stat.S_ISDIR(metadata.st_mode):
        fail(f"{label} must be a directory")
    if expected_type == "file" and not stat.S_ISREG(metadata.st_mode):
        fail(f"{label} must be a regular file")
    if metadata.st_uid != uid:
        fail(f"{label} has an unexpected owner")
    if mode_of(metadata) != expected_mode:
        fail(f"{label} mode must be exactly {expected_mode:04o}")
    if expected_type == "file" and metadata.st_nlink != 1:
        fail(f"{label} must have exactly one hard link")
    return metadata


def validate_existing_ancestors(path: Path, uid: int, stop: Path | None) -> None:
    current = path
    while not current.exists() and not current.is_symlink():
        if current == current.parent:
            break
        current = current.parent
    while True:
        metadata = current.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            fail("installation path contains a symlink")
        if not stat.S_ISDIR(metadata.st_mode):
            fail("installation path contains a non-directory component")
        if current != Path(current.anchor) and metadata.st_uid not in (0, uid):
            fail("installation path contains an untrusted owner")
        if mode_of(metadata) & 0o022:
            fail("installation path contains a group/world-writable ancestor")
        if stop is not None and current == stop:
            break
        if current == current.parent:
            break
        current = current.parent


def ensure_private_directory(path: Path, uid: int, stop: Path | None) -> None:
    validate_existing_ancestors(path, uid, stop)
    missing: list[Path] = []
    current = path
    while not current.exists():
        missing.append(current)
        current = current.parent
    for directory in reversed(missing):
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            # A concurrent installer may create the same private component.
            # Accept only after the same exact owner/type/mode inspection.
            pass
        except OSError as exc:
            fail(f"cannot create private installation directory: {exc}")
        inspect_entry(directory, "directory", 0o700, uid, "new installation directory")
    inspect_entry(path, "directory", 0o700, uid, "installation directory")


def expected_directories(manifest: dict[str, Any]) -> set[str]:
    result: set[str] = set()
    for entry in manifest["files"]:
        parent = PurePosixPath(entry["path"]).parent
        while parent != PurePosixPath("."):
            result.add(parent.as_posix())
            parent = parent.parent
    return result


def validate_generation(path: Path, manifest: dict[str, Any], manifest_bytes: bytes, uid: int) -> None:
    inspect_entry(path, "directory", 0o700, uid, "runtime generation")
    expected_files = {entry["path"] for entry in manifest["files"]} | {"manifest.json"}
    expected_dirs = expected_directories(manifest)
    actual_files: set[str] = set()
    actual_dirs: set[str] = set()

    for parent, directories, files in os.walk(path, topdown=True, followlinks=False):
        parent_path = Path(parent)
        for name in directories:
            candidate = parent_path / name
            relative = candidate.relative_to(path).as_posix()
            inspect_entry(candidate, "directory", 0o700, uid, f"generation directory {relative}")
            actual_dirs.add(relative)
        for name in files:
            candidate = parent_path / name
            relative = candidate.relative_to(path).as_posix()
            actual_files.add(relative)

    if actual_dirs != expected_dirs or actual_files != expected_files:
        fail("runtime generation inventory does not exactly match its manifest")

    installed_manifest = path / "manifest.json"
    inspect_entry(installed_manifest, "file", 0o600, uid, "installed runtime manifest")
    try:
        actual_manifest = installed_manifest.read_bytes()
    except OSError as exc:
        fail(f"installed runtime manifest cannot be read: {exc}")
    if actual_manifest != manifest_bytes:
        fail("installed runtime manifest does not match the trusted source manifest (a manifest edit requires a new generation string; remove the stale generation directory to reinstall)")

    for entry in manifest["files"]:
        candidate = path / entry["path"]
        metadata = inspect_entry(candidate, "file", int(entry["mode"], 8), uid, f"installed file {entry['path']}")
        if metadata.st_size != entry["size"]:
            fail(f"installed file size mismatch: {entry['path']}")
        if sha256_file(candidate) != entry["sha256"]:
            fail(f"installed file digest mismatch: {entry['path']}")


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_exclusive(path: Path, data: bytes, mode: int) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, mode)
    try:
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def acquire_archive(manifest: dict[str, Any], archive_override: Path | None, cache_root: Path, uid: int, stop: Path | None) -> Path:
    source = manifest["source"]
    if archive_override is not None:
        archive = archive_override
        inspect_entry(archive, "file", 0o600, uid, "test archive")
    else:
        ensure_private_directory(cache_root, uid, stop)
        # Content-addressed cache key: two manifests sharing an asset name
        # cannot collide, and a stale or planted file cannot pin the name.
        archive = cache_root / f"{source['sha256']}-{source['asset']}"
        if not archive.exists() and not archive.is_symlink():
            temporary = cache_root / f".{source['asset']}.part-{os.getpid()}"
            if temporary.exists() or temporary.is_symlink():
                fail("download staging path already exists")
            info("downloading pinned sqlite-vec Linux ARM64 archive")
            # --proto limits the initial transfer; --proto-redir limits what a
            # redirect may switch to (GitHub release assets redirect once).
            command = [
                "curl", "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2",
                "--fail", "--location", "--connect-timeout", "10", "--max-time", "300",
                "--silent", "--show-error", "--output", str(temporary), source["url"],
            ]
            try:
                try:
                    completed = subprocess.run(command, check=False)
                except OSError as exc:
                    fail(f"cannot execute curl: {exc}", 2)
                if completed.returncode != 0:
                    fail("pinned runtime archive download failed")
                os.chmod(temporary, 0o600)
                with temporary.open("rb") as stream:
                    os.fsync(stream.fileno())
                if sha256_file(temporary) != source["sha256"]:
                    fail("downloaded runtime archive digest mismatch")
                os.replace(temporary, archive)
                fsync_directory(cache_root)
            finally:
                temporary.unlink(missing_ok=True)
        inspect_entry(archive, "file", 0o600, uid, "cached runtime archive")
        if sha256_file(archive) != source["sha256"]:
            # Never leave a wrong-digest file where it would block every later
            # run; the failure below still refuses this run.
            archive.unlink(missing_ok=True)
            info("removed a cached runtime archive whose digest did not match")
    if sha256_file(archive) != source["sha256"]:
        fail("runtime archive digest mismatch")
    return archive


def populate_staging(staging: Path, archive: Path, manifest: dict[str, Any], manifest_bytes: bytes, uid: int) -> None:
    expected_members = {entry["archivePath"]: entry for entry in manifest["files"]}
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            members = bundle.getmembers()
            by_name: dict[str, tarfile.TarInfo] = {}
            for member in members:
                # GNU tar emits "./name" by default; accept exactly one such
                # prefix, then require a normalized relative path.
                raw_name = member.name[2:] if member.name.startswith("./") else member.name
                normalized = safe_relative_path(raw_name, "archive member")
                if normalized in by_name:
                    fail("runtime archive contains a duplicate member")
                by_name[normalized] = member
                if not member.isfile():
                    fail("runtime archive contains a non-regular member")
            if set(by_name) != set(expected_members):
                fail("runtime archive inventory does not exactly match the manifest")

            for entry in manifest["files"]:
                member = by_name[entry["archivePath"]]
                if member.size != entry["size"]:
                    fail("runtime archive member size does not match the manifest")
                destination = staging / entry["path"]
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                for parent in destination.parents:
                    if parent == staging:
                        break
                    os.chmod(parent, 0o700)
                source = bundle.extractfile(member)
                if source is None:
                    fail("runtime archive member cannot be read")
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(destination, flags, int(entry["mode"], 8))
                try:
                    remaining = entry["size"]
                    with source:
                        while remaining:
                            chunk = source.read(min(1024 * 1024, remaining))
                            if not chunk:
                                fail("runtime archive member ended before its declared size")
                            view = memoryview(chunk)
                            while view:
                                written = os.write(descriptor, view)
                                view = view[written:]
                            remaining -= len(chunk)
                        if source.read(1):
                            fail("runtime archive member exceeds its declared size")
                    os.fchmod(descriptor, int(entry["mode"], 8))
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
    except InstallFailure:
        raise
    except (OSError, tarfile.TarError) as exc:
        fail(f"runtime archive extraction failed: {exc}")

    write_exclusive(staging / "manifest.json", manifest_bytes, 0o600)
    for directory in sorted(expected_directories(manifest), key=lambda item: item.count("/"), reverse=True):
        fsync_directory(staging / directory)
    fsync_directory(staging)
    validate_generation(staging, manifest, manifest_bytes, uid)


def selector_bytes(generation: str, manifest_digest: str) -> bytes:
    value = {
        "schemaVersion": SELECTOR_SCHEMA_VERSION,
        "generation": generation,
        "manifestSha256": manifest_digest,
    }
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def validate_selector(selector: Path, generations: Path, trusted: dict[str, tuple[dict[str, Any], bytes]], uid: int) -> str | None:
    if not selector.exists() and not selector.is_symlink():
        return None
    inspect_entry(selector, "file", 0o600, uid, "runtime selector")
    try:
        value = json.loads(selector.read_text(encoding="utf-8"), object_pairs_hook=duplicate_rejecting_object)
    except InstallFailure:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail("runtime selector is malformed")
    value = exact_keys(value, {"schemaVersion", "generation", "manifestSha256"}, "runtime selector")
    if value["schemaVersion"] != SELECTOR_SCHEMA_VERSION:
        fail("runtime selector schema is unsupported")
    generation = value["generation"]
    digest = value["manifestSha256"]
    if generation not in trusted or not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
        fail("runtime selector references an untrusted generation")
    manifest, manifest_bytes = trusted[generation]
    if digest != sha256_bytes(manifest_bytes):
        fail("runtime selector manifest digest mismatch")
    validate_generation(generations / generation, manifest, manifest_bytes, uid)
    return generation


def atomic_select(root: Path, selector: Path, generation: str, manifest_digest: str, uid: int) -> None:
    temporary = root / f".current-generation-{os.getpid()}"
    if temporary.exists() or temporary.is_symlink():
        fail("selector staging path already exists")
    try:
        write_exclusive(temporary, selector_bytes(generation, manifest_digest), 0o600)
        os.replace(temporary, selector)
        fsync_directory(root)
        inspect_entry(selector, "file", 0o600, uid, "runtime selector")
    finally:
        temporary.unlink(missing_ok=True)


def load_trusted_manifests(paths: list[Path]) -> dict[str, tuple[dict[str, Any], bytes]]:
    trusted: dict[str, tuple[dict[str, Any], bytes]] = {}
    for path in paths:
        manifest, manifest_bytes = load_manifest(path)
        generation = manifest["generation"]
        if generation in trusted:
            fail("trusted manifests contain a duplicate generation", 2)
        trusted[generation] = (manifest, manifest_bytes)
    if not trusted:
        fail("no trusted runtime manifests are installed", 2)
    return trusted


def install_runtime(
    *,
    manifest_path: Path,
    trusted_manifest_paths: list[Path],
    root: Path,
    cache_root: Path,
    observed_platform: str,
    trusted_anchor: Path,
    prohibited_roots: list[Path],
    archive_override: Path | None = None,
    failpoint: str | None = None,
    expected_uid: int | None = None,
 ) -> int:
    """Install one target manifest using an explicit trusted-manifest set.

    Production passes only checked-in manifests, a passwd-derived home, and the
    observed host tuple. The fixture driver supplies isolated test values.
    """
    manifest, manifest_bytes = load_manifest(manifest_path)
    trusted = load_trusted_manifests(trusted_manifest_paths)
    if manifest["generation"] not in trusted or trusted[manifest["generation"]][1] != manifest_bytes:
        fail("target runtime manifest is absent from the trusted manifest set", 2)
    if observed_platform not in ("linux-aarch64", "linux-arm64"):
        fail(f"unsupported host for expertise runtime installation: {observed_platform}", 2)

    uid = os.geteuid() if expected_uid is None else expected_uid
    root = root.absolute()
    cache_root = cache_root.absolute()
    trusted_anchor = trusted_anchor.resolve(strict=False)
    if not root.is_absolute() or not cache_root.is_absolute():
        fail("runtime installation and cache roots must be absolute", 2)
    root_canonical = root.resolve(strict=False)
    cache_canonical = cache_root.resolve(strict=False)
    try:
        root_canonical.relative_to(trusted_anchor)
    except ValueError:
        fail("runtime installation root must remain under the trusted user home", 2)
    for prohibited in prohibited_roots:
        prohibited_canonical = prohibited.resolve(strict=False)
        try:
            root_canonical.relative_to(prohibited_canonical)
            fail("runtime installation root is inside a prohibited repository or cache", 2)
        except ValueError:
            pass
    try:
        root_canonical.relative_to(cache_canonical)
        fail("runtime installation root must not be inside its acquisition cache", 2)
    except ValueError:
        pass

    ensure_private_directory(root, uid, trusted_anchor)
    generations = root / "generations"
    ensure_private_directory(generations, uid, root)

    lock_path = root / "install.lock"
    if not lock_path.exists() and not lock_path.is_symlink():
        try:
            write_exclusive(lock_path, b"", 0o600)
            fsync_directory(root)
        except FileExistsError:
            # A concurrent installer won lock creation; exact inspection below
            # determines whether the resulting entry is acceptable.
            pass
    inspect_entry(lock_path, "file", 0o600, uid, "runtime installer lock")

    with lock_path.open("r+b") as lock_stream:
        fcntl.flock(lock_stream.fileno(), fcntl.LOCK_EX)
        # A run killed between mkdtemp and rename leaves a staging tree that
        # no inventory covers; sweep it under the lock so it cannot linger
        # beside validated generations.
        for stale in sorted(generations.glob(".staging-*")):
            if stale.is_dir() and not stale.is_symlink():
                info(f"removing stale staging directory {stale.name}")
                shutil.rmtree(stale)
        selector = root / "current-generation"
        selected_before = validate_selector(selector, generations, trusted, uid)
        if selected_before is not None and generation_version(selected_before) > generation_version(manifest["generation"]):
            fail("refusing to select an older generation than the currently selected one")
        generation_path = generations / manifest["generation"]

        if generation_path.exists() or generation_path.is_symlink():
            validate_generation(generation_path, manifest, manifest_bytes, uid)
            reused = True
        else:
            archive = acquire_archive(manifest, archive_override, cache_root, uid, trusted_anchor)
            staging = Path(tempfile.mkdtemp(prefix=f".staging-{manifest['generation']}-", dir=generations))
            os.chmod(staging, 0o700)
            try:
                populate_staging(staging, archive, manifest, manifest_bytes, uid)
                if failpoint == "after-stage":
                    fail("test failpoint after staged-generation validation")
                if generation_path.exists() or generation_path.is_symlink():
                    fail("runtime generation appeared concurrently")
                os.rename(staging, generation_path)
                fsync_directory(generations)
                if failpoint == "after-publish":
                    fail("test failpoint after generation publication")
                staging = Path()
            finally:
                if staging != Path() and staging.exists():
                    shutil.rmtree(staging)
            validate_generation(generation_path, manifest, manifest_bytes, uid)
            reused = False

        manifest_digest = sha256_bytes(manifest_bytes)
        desired_selector = selector_bytes(manifest["generation"], manifest_digest)
        if selected_before == manifest["generation"] and selector.read_bytes() == desired_selector:
            skip("digest-attested expertise runtime generation already selected")
        else:
            atomic_select(root, selector, manifest["generation"], manifest_digest, uid)
        validate_selector(selector, generations, trusted, uid)
        if reused:
            ok("validated existing digest-attested expertise runtime generation")
        else:
            ok("installed and selected digest-attested expertise runtime generation")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-manifest", action="store_true", help="validate every checked-in runtime manifest without installing")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parent.parent
    manifest_dir = repo_root / "agent/vendor/expertise-runtime"
    trusted_manifest_paths = sorted(manifest_dir.glob("linux-arm64-v*.json"))
    load_trusted_manifests(trusted_manifest_paths)
    # The production target is always the highest checked-in generation, so a
    # host that already selected a newer generation is never reverted.
    versioned = {}
    for path in trusted_manifest_paths:
        match = re.fullmatch(r"linux-arm64-v([0-9]+)\.json", path.name)
        if match is None:
            fail(f"unexpected runtime manifest name: {path.name}", 2)
        versioned[int(match.group(1))] = path
    if not versioned:
        fail("target Linux ARM64 runtime manifest is missing", 2)
    target_manifest = versioned[max(versioned)]
    if args.check_manifest:
        ok("expertise runtime manifests are structurally valid")
        return 0

    uid = os.geteuid()
    try:
        trusted_home = Path(pwd.getpwuid(uid).pw_dir).absolute()
    except KeyError:
        fail("current user has no passwd home directory", 2)
    observed = f"{platform.system().lower()}-{platform.machine().lower()}"
    return install_runtime(
        manifest_path=target_manifest,
        trusted_manifest_paths=trusted_manifest_paths,
        root=trusted_home / ".local/share/agent-expertise/runtime",
        cache_root=trusted_home / ".cache/agent-expertise/runtime-downloads",
        observed_platform=observed,
        trusted_anchor=trusted_home,
        prohibited_roots=[repo_root, trusted_home / ".cache"],
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except InstallFailure as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        raise SystemExit(exc.code)
    except OSError as exc:
        # Fail closed, but never spell a crash as a refusal (exit 1).
        print(f"ERROR unexpected filesystem error: {exc}", file=sys.stderr)
        raise SystemExit(3)
