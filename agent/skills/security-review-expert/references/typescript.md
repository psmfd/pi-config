# TypeScript / JavaScript

Node.js backend (Express, Fastify, NestJS) and modern frontend (React, Next.js).

## Type system gaps

- `any` at HTTP handler entry points silently disables compile-time type guarantees downstream.
- `as unknown as TargetType` double-assertion at trust boundaries is a deliberate compiler override — every occurrence is a potential type-confusion path.
- `JSON.parse(body)` returns `any`. Without `zod.parse()` / `io-ts.decode()` / `valibot.parse()` immediately after, the entire downstream call graph operates on unvalidated data.
- `satisfies` verifies shape at assignment but does not guard runtime values.

## Prototype pollution

- `Object.assign({}, defaults, userBody)` — `__proto__` keys in `userBody` mutate `Object.prototype`.
- `_.merge(target, userInput)` in lodash &lt; 4.17.21 (CVE-2020-8203). Even patched versions need explicit key filtering or `Object.create(null)` targets.
- `JSON.parse('{"__proto__":...}')` piped to any merge utility — the `__proto__` key survives parsing and is treated as a prototype assignment.
- `obj[userKey][userKey2] = value` — depth attack that `__proto__`-only filtering misses.

## XSS

- `dangerouslySetInnerHTML={{__html: userContent}}` without DOMPurify or Trusted Types.
- `element.innerHTML = value` in `useEffect` or event handlers — React's JSX escaping does not apply.
- Next.js `<Link href={userInput}>` accepts `javascript:` URIs in older versions; verify version and scheme allowlist.
- `document.write()` in SSR hydration paths breaks CSP nonce delivery.

## CSP and security headers

- `helmet()` defaults to `report-only` for CSP — no enforcement. Verify `contentSecurityPolicy` is enforcement-mode.
- Static nonces (set at module load) are equivalent to no nonce. Generate per-request via `crypto.randomBytes`.
- Missing `frame-ancestors 'none'` in CSP relies on the deprecated `X-Frame-Options` header.
- `@fastify/helmet` requires explicit CSP configuration — not enabled by default.

## Auth and session

- `express-session({secret: process.env.SESSION_SECRET})` without entropy validation. If the env var is empty, session HMAC keys are empty.
- Cookie flags: `httpOnly: false`, `secure: false`, `sameSite: 'none'` without `secure: true`.
- `jwt.verify(token, secret)` without `{ algorithms: ['RS256'] }` — older `jsonwebtoken` accepts `alg:none`. Even current versions accept any algorithm matching the key type.
- `jwt.decode()` does not verify signature — flag any authorization decision based on its output.
- Refresh token rotation without single-use enforcement makes token theft undetectable.

## TLS / certificate handling

- `rejectUnauthorized: false` in `https.request` / `tls.connect` options.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` in `.env`, Compose files, or CI environment blocks — process-wide.
- `checkServerIdentity: () => undefined` — bypasses hostname verification while passing chain validation.

## Dynamic execution

- `eval(userInput)`, `new Function(body)()`, `setTimeout(stringArg, 0)`.
- `vm.runInThisContext()` runs in the current V8 context — not a security boundary.

## Command injection

- `child_process.exec(template literal)` passes the full string to `/bin/sh`.
- `spawn('bash', ['-c', userInput])` reintroduces shell interpretation.
- `spawn(cmd, args, {shell: true})` defeats array-args safety.
- `shell-quote` is POSIX-targeted; on Windows `cmd.exe` it does not escape `%VAR%` or `^`.

## Supply chain (gaps `npm audit` cannot cover)

- Permissive ranges (`^`, `~`, `*`) on auth/crypto packages allow silent algorithm-default changes.
- `postinstall` / `prepare` scripts in transitive deps execute on every install.
- Internal scoped packages (`@scope/name`) without `publishConfig.registry` or `.npmrc` lockdown enable dependency confusion.
- Missing `package-lock.json` (or `.gitignore`d) means `^` ranges resolve at install time.

## Next.js Server Components and Server Actions

- Modules with DB clients or `process.env` secrets without `import 'server-only'` can be tree-shaken into the client bundle.
- `<ClientComponent prop={dbRow} />` serializes raw DB fields (including `hashedPassword`, `internalRole`) into the RSC payload — visible in the browser network tab.
- `'use server'` actions without explicit input validation and ownership checks; direct object reference via `FormData.get('id')`.
- Server Actions called from `app/api/` route handlers bypass Next.js's CSRF origin protection.

## First-party entry points (TypeScript)

- TS strict compiler options: `www.typescriptlang.org/tsconfig#strict`
- TS type narrowing: `www.typescriptlang.org/docs/handbook/2/narrowing.html`
- Node.js child_process: `nodejs.org/api/child_process.html`
- Node.js TLS: `nodejs.org/api/tls.html`
- MDN CSP: `developer.mozilla.org/en-US/docs/Web/HTTP/CSP`
- MDN Set-Cookie: `developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie`
- React `dangerouslySetInnerHTML`: `react.dev/reference/react-dom/components/common`
- Next.js Server Actions: `nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations`
- Next.js headers config: `nextjs.org/docs/app/api-reference/config/next-config-js/headers`
- Express session: `expressjs.com/en/resources/middleware/session.html`
- OWASP Prototype Pollution Cheat Sheet: `cheatsheetseries.owasp.org/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.html`
