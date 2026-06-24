# Python

CPython 3.11+, Django, Flask, FastAPI, common stdlib pitfalls.

## Deserialization

- `pickle.loads()` / `shelve.open()` / `marshal.loads()` on data that crossed a network or untrusted filesystem path. The design failure is treating deserialization as internal when the data origin is external.
- `yaml.load(data)` or `yaml.load(data, Loader=yaml.FullLoader)` — both permit `!!python/object` execution. The safe API is `yaml.safe_load()` or `Loader=yaml.SafeLoader`.

## Subprocess and command execution

- `subprocess.run(cmd, shell=True)` with any variable in `cmd`. Safe pattern: `shell=False` with a list of args, plus `shlex.split()` only when the input is already trusted.
- `shlex.quote()` does not make `shell=True` safe — it prevents word splitting but not every injection vector.

## Template injection

- `jinja2.Environment()` without `autoescape=select_autoescape()` defaults to `autoescape=False`. Check the `Environment` constructor, not the template call site.
- `str.format(**user_dict)` lets a user with controlled keys read object attributes via `{obj.__class__.__init__.__globals__}`.
- Flask `render_template_string(user_input)` — common in dynamic-template features.

## SQL injection

- `cursor.execute("SELECT … WHERE id = %s" % (uid,))` — string interpolation occurs before the driver sees it. The safe form passes parameters as a separate argument: `cursor.execute("…", (uid,))`.
- `asyncpg` uses `$1, $2` positional parameters; code ported from psycopg2 with f-strings is the primary regression path.
- Django `.raw()`, `.extra()`, `RawSQL()` with format-string construction.

## Cryptography

- `hashlib.sha256(password)` for password storage — no salt, no iterations. Use `hashlib.scrypt` / `hashlib.pbkdf2_hmac` with ≥ 260,000 iterations, or `bcrypt` / `argon2-cffi`.
- `random.token_hex(32)` instead of `secrets.token_hex(32)`. `random` is seeded from system time and is not cryptographically secure.
- `pycryptodome` `AES.MODE_ECB` or hardcoded/reused IV in CBC. Prefer `cryptography.fernet.Fernet` or `cryptography.hazmat.primitives.ciphers.aead.AESGCM`.

## Web framework auth/authz

- Flask `SECRET_KEY` set to a short string, dev placeholder, or empty fallback (`os.environ.get("SECRET_KEY", "")`). Validate entropy at startup.
- Django `@csrf_exempt` on state-changing views — frequently added to unblock API clients without recognizing the protection removal applies to all callers.
- FastAPI `Depends()` auth dependencies that return `None` on unauthenticated requests rather than raising `HTTPException(401)`. Trace every auth dependency to verify it raises.
- JWT library calls (`jwt.decode()`) without explicit `algorithms=["RS256"]` (or equivalent) accept any algorithm matching the key — including `none` in older versions.

## Secret handling

- `logger.info("User: %s", user_obj)` where `user_obj.__str__` includes credentials. Audit `__repr__`/`__str__` on credential-bearing models.
- Exception messages that interpolate query strings, file paths, or internal state.
- `os.environ.get("API_KEY", "")` with empty default that silently disables auth checks.

## Packaging hygiene

- Unpinned ranges (`requests>=2.0`) and missing lockfile enable dependency confusion when `--extra-index-url` is used (PyPI fallback).
- `setup.py` with network calls or `subprocess.run` at install time.
- Pip invocations missing `--require-hashes` for production installs.

## First-party entry points (Python)

- subprocess security considerations: `docs.python.org/3/library/subprocess.html#security-considerations`
- secrets module: `docs.python.org/3/library/secrets.html`
- hashlib: `docs.python.org/3/library/hashlib.html`
- pickle warning: `docs.python.org/3/library/pickle.html`
- PEP 506 (secrets): `peps.python.org/pep-0506/`
- Jinja autoescape: `jinja.palletsprojects.com/en/stable/api/#autoescaping`
- Django security: `docs.djangoproject.com/en/stable/topics/security/`
- Flask security: `flask.palletsprojects.com/en/stable/security/`
- FastAPI security: `fastapi.tiangolo.com/tutorial/security/`
- cryptography AEAD: `cryptography.io/en/latest/hazmat/primitives/aead/`
- OWASP Password Storage Cheat Sheet: `cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html`
- OWASP Deserialization Cheat Sheet: `cheatsheetseries.owasp.org/cheatsheets/Deserialization_Cheat_Sheet.html`
