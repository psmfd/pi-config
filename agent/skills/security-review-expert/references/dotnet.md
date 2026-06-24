# C# / .NET

Modern .NET 10 LTS with ASP.NET Core, EF Core, Identity, and Data Protection.

## Authentication and identity

- Middleware order: `app.UseAuthentication()` must precede `app.UseAuthorization()`. Reversed order leaves authorization to evaluate against an unauthenticated principal.
- `[AllowAnonymous]` on a base controller class suppresses `[Authorize]` on every derived controller — including future ones. Check attribute inheritance chains, not just the controller under review.
- ROPC grant flow (`grant_type=password` / `ResourceOwnerPasswordCredentials`) exposes user passwords to the client. Flag any configuration that enables it.
- `DefaultAzureCredential` chain in production paths includes Visual Studio and Azure CLI credentials. Use `ManagedIdentityCredential` directly in production.
- `HttpContext.User.Identity.Name` accessed without checking `IsAuthenticated` first can return null and cause silent authorization bypass.

## Data access

- `FromSqlRaw` with C# string interpolation is the canonical EF Core SQL injection path. The safe API is `FromSql` / `FromSqlInterpolated` with `FormattableString`. Same risk applies to `ExecuteSqlRaw` and `SqlQueryRaw`.
- Column or table names cannot be parameterized — any user-controlled string in an identifier position is an injection path.
- `AsNoTracking()` can mask navigation-property ownership filters that depend on the tracked graph.
- Unbounded `Include()` on user-queryable endpoints exposes data the requester is not authorized to see.

## Serialization

- `Newtonsoft.Json` `TypeNameHandling.Auto` or `.All` enables polymorphic deserialization gadget chains — Critical unless paired with a `SerializationBinder` allowlist.
- `XmlReaderSettings.DtdProcessing = DtdProcessing.Parse` enables XXE. Default safe value is `Prohibit`.
- `BinaryFormatter` is removed in .NET 9+ but remains in framework-targeting projects. Any surviving use is a Critical deserialization vector.

## Cryptography

- `MD5` / `SHA1` for password hashing. Use `Rfc2898DeriveBytes.Pbkdf2` or `PasswordHasher<T>` from `Microsoft.AspNetCore.Identity`.
- `System.Random` for security-sensitive values. Use `RandomNumberGenerator.GetBytes()`.
- `AesGcm` (authenticated) preferred over `Aes` with `CipherMode.CBC` plus separate HMAC.
- Data Protection key ring not persisted (`builder.Services.AddDataProtection()` with no `PersistKeysTo*`) loses keys on restart and invalidates all protected payloads — Critical in containers and multi-instance deployments.
- Data Protection keys persisted without `ProtectKeysWith*` are stored in cleartext XML.

## Secret handling

- Connection strings or `AccountKey=` literals in `appsettings.json` committed to source.
- Structured logging that passes secret values as named parameters (`logger.LogInformation("Connected as {Password}", password)`).
- `IConfiguration` values rendered into exception messages captured by APM.

## Container and runtime hardening

- The `mcr.microsoft.com/dotnet/aspnet:10.0` image defines `$APP_UID` (UID 1654). Dockerfiles missing `USER $APP_UID` run as root.
- `ForwardedHeaders` middleware without scoped `KnownProxies` / `KnownNetworks` enables IP spoofing via `X-Forwarded-For`.
- Missing `UseHsts()` / `UseHttpsRedirection()` in production middleware pipelines.

## First-party entry points (.NET)

- ASP.NET Core security overview: `learn.microsoft.com/aspnet/core/security`
- Authentication: `learn.microsoft.com/aspnet/core/security/authentication`
- Authorization: `learn.microsoft.com/aspnet/core/security/authorization/introduction`
- Data Protection API: `learn.microsoft.com/aspnet/core/security/data-protection/introduction`
- App secrets: `learn.microsoft.com/aspnet/core/security/app-secrets`
- Anti-CSRF: `learn.microsoft.com/aspnet/core/security/anti-request-forgery`
- HTTPS enforcement: `learn.microsoft.com/aspnet/core/security/enforcing-ssl`
- EF Core raw SQL: `learn.microsoft.com/ef/core/querying/sql-queries`
- .NET cryptography model: `learn.microsoft.com/dotnet/standard/security/cryptography-model`
- Open redirect prevention: `learn.microsoft.com/aspnet/core/security/preventing-open-redirects`
