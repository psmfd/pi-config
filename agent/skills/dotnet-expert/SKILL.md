---
name: dotnet-expert
description: '.NET 10 LTS reference for the dotnet-expert subagent — SDK, csproj, ASP.NET Core, BackgroundService, EF Core, testing, publishing, cross-platform.'
disable-model-invocation: true
---

# .NET Expert

Read-only reference for .NET guidance — SDK tooling, cross-platform patterns, ASP.NET Core, worker services, DI lifetime rules, EF Core, testing, publishing, and security best practices.

## Overview

.NET 10 LTS is the current long-term support release. It runs on macOS (ARM64/x64), Linux (x64/ARM64/ARM32), and Windows. The unified SDK (`dotnet` CLI) handles project creation, building, testing, and publishing across all targets. Key ecosystem components: ASP.NET Core for web APIs, `BackgroundService` for worker processes, Entity Framework Core for data access, and built-in container publishing.

## SDK and Project System

### Project File Structure

```xml
<!-- Minimal .csproj for a web API -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

### Directory.Build.props

Shared properties across all projects in a solution:

```xml
<Project>
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

**Trap:** `InvariantGlobalization` reduces container image size but breaks culture-sensitive string comparisons. Only use for services that do not need locale-aware formatting.

### SDK Types

| SDK | Use when |
|---|---|
| `Microsoft.NET.Sdk` | Class libraries, console apps |
| `Microsoft.NET.Sdk.Web` | ASP.NET Core web apps and APIs |
| `Microsoft.NET.Sdk.Worker` | Worker services (BackgroundService) |

## Cross-Platform Development

### Runtime Identifiers (RIDs)

| RID | Target |
|---|---|
| `linux-x64` | Linux x86_64 (most k8s nodes) |
| `linux-arm64` | Linux ARM64 (Raspberry Pi, Graviton) |
| `osx-arm64` | macOS Apple Silicon |
| `osx-x64` | macOS Intel |
| `win-x64` | Windows x86_64 |

### Publishing Modes

| Mode | Command | Output |
|---|---|---|
| Framework-dependent | `dotnet publish` | Requires .NET runtime on target |
| Self-contained | `dotnet publish -r linux-x64 --self-contained` | Bundles runtime (~80MB) |
| AOT | `dotnet publish -r linux-x64 /p:PublishAot=true` | Native binary, no JIT |
| Container | `dotnet publish /t:PublishContainer` | OCI image, no Dockerfile needed |

### Cross-Platform Pitfalls

- **Path separators:** Use `Path.Combine()` and `Path.DirectorySeparatorChar`, never hardcode `/` or `\`
- **File system case sensitivity:** Linux is case-sensitive, macOS/Windows are not by default. Test on Linux.
- **Line endings:** Use `.gitattributes` with `* text=auto` to normalize
- **Native dependencies:** SQLite, gRPC, and crypto libraries have platform-specific native binaries. NuGet runtime packages handle this, but AOT builds require explicit RID targeting.

## ASP.NET Core

### Minimal API Pattern

```csharp
WebApplicationBuilder builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<IMyService, MyService>();

WebApplication app = builder.Build();
app.MapGet("/health", () => Results.Ok());
app.MapPost("/api/items", async (CreateItemRequest req, IMyService svc) =>
{
    Item result = await svc.CreateAsync(req);
    return Results.Created($"/api/items/{result.Id}", result);
});
app.Run();
```

### Middleware Pipeline

Middleware order matters. The pipeline executes in registration order for requests and reverse order for responses.

```csharp
app.UseExceptionHandler("/error");
app.UseHsts();
app.UseHttpsRedirection();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
```

**Trap:** `UseAuthentication()` must come before `UseAuthorization()`. Reversing them causes authorization to run against an unauthenticated principal.

### Configuration and Options Pattern

```csharp
// Bind a config section to a strongly-typed object
builder.Services.Configure<InferenceOptions>(
    builder.Configuration.GetSection("Inference"));

// Inject via IOptions<T>, IOptionsSnapshot<T>, or IOptionsMonitor<T>
public class MyService(IOptions<InferenceOptions> options) { }
```

| Interface | Lifetime | Reloads |
|---|---|---|
| `IOptions<T>` | Singleton | No — reads config once at startup |
| `IOptionsSnapshot<T>` | Scoped | Yes — per-request in web apps |
| `IOptionsMonitor<T>` | Singleton | Yes — fires `OnChange` callback |

**Trap:** `IOptions<T>` never reloads. If your config source changes at runtime (e.g., Azure App Configuration), use `IOptionsMonitor<T>`.

## Worker Services

### BackgroundService Pattern

```csharp
public class QueueProcessor : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await ProcessBatchAsync(stoppingToken);
            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
        }
    }
}
```

### Hosted Service Lifecycle

| Event | Order |
|---|---|
| `StartAsync` | Called in registration order after `IHostApplicationLifetime.ApplicationStarted` |
| `StopAsync` | Called in reverse registration order on shutdown |

**Trap:** `ExecuteAsync` runs on a single thread. If it throws an unhandled exception, the host terminates (default behavior in .NET 6+). Always catch and log exceptions in the loop body, or configure `HostOptions.BackgroundServiceExceptionBehavior`.

### Scoped Services in BackgroundService

`BackgroundService` is a singleton. To use scoped services (e.g., `DbContext`), create a scope manually:

```csharp
public class Worker(IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            using IServiceScope scope = scopeFactory.CreateScope();
            AppDbContext db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await ProcessAsync(db, ct);
            await Task.Delay(TimeSpan.FromMinutes(1), ct);
        }
    }
}
```

## Dependency Injection

### Service Lifetimes

| Lifetime | Scope | Trap |
|---|---|---|
| `Singleton` | One instance for app lifetime | Must be thread-safe. Never inject Scoped services. |
| `Scoped` | One instance per scope (per HTTP request in web) | Captured by singletons = lifetime mismatch bug |
| `Transient` | New instance every resolution | Expensive if resolved frequently in hot paths |

### Scope Validation

Enable in development to catch lifetime mismatches at startup:

```csharp
builder.Host.UseDefaultServiceProvider(options =>
{
    options.ValidateScopes = true;
    options.ValidateOnBuild = true;
});
```

**Trap:** `ValidateScopes` is enabled by default in Development but disabled in Production. A singleton capturing a scoped service will work in development (throws on resolution) but silently misbehave in production if validation is off and the first request sets the captured instance.

### Keyed Services

```csharp
builder.Services.AddKeyedSingleton<ICache, RedisCache>("distributed");
builder.Services.AddKeyedSingleton<ICache, MemoryCache>("local");

public class MyService([FromKeyedServices("distributed")] ICache cache) { }
```

## Entity Framework Core

### DbContext Lifetime

Register as scoped (default). Never register as singleton — `DbContext` is not thread-safe.

```csharp
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default")));
```

### Migrations

```bash
dotnet ef migrations add InitialCreate
dotnet ef database update
```

**Trap:** Migration ordering is by filename timestamp. If two developers create migrations concurrently, the model snapshot diverges. Resolve by deleting one migration, merging the model snapshot, and recreating.

### Connection Resiliency

```csharp
options.UseNpgsql(connectionString, npgsql =>
    npgsql.EnableRetryOnFailure(
        maxRetryCount: 3,
        maxRetryDelay: TimeSpan.FromSeconds(10),
        errorCodesToAdd: null));
```

**Trap:** Retry logic wraps the entire `SaveChangesAsync` call. If your operation is not idempotent, retries can cause duplicate writes. Use execution strategies with explicit transactions for non-idempotent operations.

## Testing

### WebApplicationFactory

```csharp
public class ApiTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public ApiTests(WebApplicationFactory<Program> factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task HealthEndpointReturnsOk()
    {
        HttpResponseMessage response = await _client.GetAsync("/health");
        response.EnsureSuccessStatusCode();
    }
}
```

### Replacing Services in Tests

```csharp
WebApplicationFactory<Program> factory = new WebApplicationFactory<Program>()
    .WithWebHostBuilder(builder =>
    {
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<IMyService>();
            services.AddSingleton<IMyService, FakeMyService>();
        });
    });
```

## Security Best Practices

### HTTPS and Transport

- Always call `app.UseHttpsRedirection()` in production
- Use `app.UseHsts()` to send Strict-Transport-Security header
- In containers behind a reverse proxy, configure forwarded headers:

```csharp
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
});
app.UseForwardedHeaders();
```

### Secrets Management

| Environment | Method |
|---|---|
| Development | `dotnet user-secrets` (stored outside project tree) |
| Production | Environment variables, Azure Key Vault, or mounted secrets |
| Never | `appsettings.json` committed to source control |

```bash
dotnet user-secrets init
dotnet user-secrets set "ConnectionStrings:Default" "Host=..."
```

### Input Validation

- Use data annotations or FluentValidation on request models
- Never trust client-supplied IDs for authorization — always verify ownership server-side
- Use parameterized queries (EF Core does this by default) — never concatenate SQL

### Authentication Patterns

```csharp
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.microsoftonline.com/{tenant}";
        options.Audience = "api://my-api";
    });
```

For Azure workloads, use `DefaultAzureCredential` which chains managed identity, CLI, and environment credentials.

## Container Publishing

### Built-in Container Support

```bash
# Publish as container image — no Dockerfile needed
dotnet publish /t:PublishContainer \
  -p ContainerRepository=myapp \
  -p ContainerImageTag=v1.0.0
```

### Dockerfile Pattern (when customization needed)

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY *.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .
USER $APP_UID
ENTRYPOINT ["dotnet", "MyApp.dll"]
```

**Trap:** The `aspnet` base image is for web apps. Worker services should use `mcr.microsoft.com/dotnet/runtime:10.0` instead.

### Container Security

- Run as non-root: the official images define `$APP_UID` (UID 1654)
- Use `readOnlyRootFilesystem: true` in Kubernetes — but mount an `emptyDir` at `/tmp` because .NET runtime writes temp files there
- Scan images with `trivy` or `grype` in CI

## NuGet Package Management

### Central Package Management

```xml
<!-- Directory.Packages.props -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="10.0.0" />
  </ItemGroup>
</Project>
```

Individual .csproj files reference packages without versions:

```xml
<PackageReference Include="Microsoft.EntityFrameworkCore" />
```

**Trap:** Mixing central and per-project version management causes build errors. If `ManagePackageVersionsCentrally` is enabled, all `PackageReference` elements with `Version` attributes generate warnings.

## Common Patterns

### Health Checks

```csharp
builder.Services.AddHealthChecks()
    .AddNpgSql(connectionString)
    .AddCheck<CustomHealthCheck>("custom");

app.MapHealthChecks("/health");
```

### Logging

```csharp
// Structured logging with ILogger<T>
public class MyService(ILogger<MyService> logger)
{
    public void Process(int itemId)
    {
        logger.LogInformation("Processing item {ItemId}", itemId);
    }
}
```

**Trap:** Use message templates (`{ItemId}`) not string interpolation (`$"{itemId}"`). Interpolation bypasses structured logging and prevents log aggregation.

## Type Declaration Style

This section covers type annotation at variable declaration sites — local variables, `foreach` iterators, `using` declarations, `out` parameters, and tuple deconstruction.

### Policy

Declare types explicitly. Use `var` only when the type cannot be expressed in source — namely, anonymous types from LINQ projections (`select new { ... }`). The rule applies uniformly to every declaration site: locals, `foreach` iterators, `using` declarations, `out` parameters, and tuple deconstruction. There is no "type is evident from context" exception — the C# compiler always knows the type, but readers and reviewers do not.

Explicit types document behavior at the declaration site. A reader scanning a method or a diff sees the type without resolving the right-hand side or hovering in an IDE. This matters most in PR review and in long methods.

### Analyzer enforcement

The rule is mechanically enforced by promoting `IDE0008` ("Use explicit type instead of `var`") to error severity, with the three `csharp_style_var_*` preferences set to `false` so the analyzer fires on every `var` usage. Combined with the file's earlier `TreatWarningsAsErrors` recommendation, any `var` declaration breaks the build.

```ini
# .editorconfig
[*.cs]
csharp_style_var_for_built_in_types = false
csharp_style_var_when_type_is_apparent = false
csharp_style_var_elsewhere = false
dotnet_diagnostic.IDE0008.severity = error
```

**Trap:** `IDE0008` is the "use explicit type instead of `var`" diagnostic; its inverse, `IDE0007` ("use `var` instead of explicit type"), must not also be promoted — the two are mutually exclusive and enabling both produces contradictory fix suggestions. The preference values (`false` here) decide which one is active; only promote the severity of the one that matches the preference.

### Escape hatch

When an explicit type harms readability more than `var` does — typically deeply nested generics returned by fluent builders or source-generated types whose name is unstable — suppress `IDE0008` for the single declaration with a justification comment. The comment is mandatory; an unjustified suppression is a review-blocking finding.

```csharp
// IDE0008: explicit type would be IAsyncEnumerable<IGrouping<DateOnly, OrderProjection>>;
// the var form is materially more readable and the type is visible one line down in the foreach.
#pragma warning disable IDE0008
var grouped = orders
    .Where(o => o.PlacedAt >= since)
    .GroupBy(o => DateOnly.FromDateTime(o.PlacedAt))
    .Select(g => new OrderProjection(g.Key, g.Count()));
#pragma warning restore IDE0008

await foreach (OrderProjection projection in grouped)
{
    // ...
}
```

Anonymous LINQ projections (next subsection) do **not** need this pragma — they are the documented case where `var` is required by the language, and `IDE0008` treats anonymous-type targets as exempt because no explicit form exists.

### When `var` is required

Only one case: anonymous types produced by LINQ projections.

```csharp
var projection = items.Select(x => new { x.Id, x.Name });
```

If the result needs to escape the method or be passed across a boundary, define a named record instead and use the explicit type.

```csharp
public record ItemSummary(int Id, string Name);

IEnumerable<ItemSummary> projection = items.Select(x => new ItemSummary(x.Id, x.Name));
```

### Examples

| Use this | Not this |
|---|---|
| `WebApplicationBuilder builder = WebApplication.CreateBuilder(args);` | `var builder = WebApplication.CreateBuilder(args);` |
| `AppDbContext db = scope.ServiceProvider.GetRequiredService<AppDbContext>();` | `var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();` |
| `using IServiceScope scope = scopeFactory.CreateScope();` | `using var scope = scopeFactory.CreateScope();` |
| `foreach (Item item in items)` | `foreach (var item in items)` |
| `if (int.TryParse(s, out int value))` | `if (int.TryParse(s, out var value))` |
| `(int id, string name) = tuple;` | `var (id, name) = tuple;` |

`using var` and `using IServiceScope` produce identical disposal semantics — both call `Dispose()` at the end of the enclosing scope. `IServiceScope` implements `IDisposable`, so synchronous `using` is correct here even though resolved services may implement `IAsyncDisposable` — the scope disposes its services transitively via the provider.

### See also

- `agent-expertise-api` ADR-011 — *Type declaration style: prefer explicit types over `var`* (tracked in `agent-expertise-api#210`). The upstream ADR is the source of truth for the repo-policy framing; this skill section will be updated with the canonical filename once the ADR is accepted.

## Pitfalls and Caveats

- **Async void:** Never use `async void` except in event handlers. Exceptions in `async void` methods crash the process.
- **ConfigureAwait(false):** Not needed in ASP.NET Core (no `SynchronizationContext`), but still required in libraries that may be consumed by UI frameworks.
- **IAsyncDisposable:** `DbContext` implements `IAsyncDisposable`. Use `await using` in manual scope management.
- **Nullable reference types:** Enable `<Nullable>enable</Nullable>` project-wide. Suppress warnings only with a comment explaining why.
- **Hot reload:** `dotnet watch` supports hot reload for Razor and C# changes, but not for startup code changes (middleware registration, DI configuration).
