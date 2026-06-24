# AWS Route 53

## Hosted zones

| Type | Purpose |
|---|---|
| Public | Internet-resolvable. Charged per zone + per query. |
| Private | Resolvable only inside associated VPC(s). Free per zone; charged per query. |

A single domain can have both a public and a private zone with the same name (**split-horizon DNS**) — VPC clients see private records, internet clients see public records. Common pattern for internal vs external endpoints on the same FQDN.

## Record types of note

| Type | Notes |
|---|---|
| `A` / `AAAA` | IPv4 / IPv6 addresses |
| `CNAME` | Alias to another DNS name — **cannot exist at zone apex** (RFC) |
| `Alias` (Route 53 extension) | Apex-compatible alias to AWS targets (ALB, NLB, CloudFront, S3 website, API Gateway, ELB, Global Accelerator, another Route 53 record). No query charge. |
| `MX` / `TXT` / `SRV` / `CAA` | Standard |
| `NS` | Delegation records; auto-created for the zone itself; only edit at the parent zone for subdomain delegation |
| `SOA` | Auto-managed; do not edit directly |

**Alias vs CNAME at apex.** CNAME at the zone apex is forbidden by the DNS spec. Route 53 alias records solve this for AWS targets. For non-AWS targets at the apex, you cannot use Route 53 — you need a DNS provider with apex-CNAME support (Cloudflare CNAME flattening, NS1 ALIAS, etc.).

## Routing policies

| Policy | Behavior |
|---|---|
| Simple | One record, one or more values, round-robin client-side |
| Weighted | Distribute by weight (0–255); 0 = stop sending |
| Latency | Route to the lowest-latency Region with a healthy endpoint |
| Failover | Primary + secondary; secondary only when primary health check fails |
| Geolocation | Route by client continent / country / state (US only) |
| Geoproximity (Traffic Flow only) | Route by geographic distance with optional bias |
| Multivalue | Up to 8 healthy records returned per query; client-side failover |

Failover, latency, weighted, geolocation, and multivalue can be combined with **health checks** for unhealthy-record exclusion.

## Health checks

- HTTP / HTTPS / TCP endpoint, CloudWatch metric, or another health check (calculated).
- Default 30s interval (10s "fast" available, +cost). 3 consecutive failures = unhealthy by default.
- Health checks originate from 15 globally distributed checker locations; allow their IP ranges if your endpoint firewalls.
- **String matching** option for HTTP — fails if response body does not contain a specified string. Useful for "page renders but app is broken" cases.
- Health checks have a fixed cost per check per month + per failover record cost.

## DNSSEC

Route 53 supports DNSSEC signing for public hosted zones (since 2020). Two steps:

1. Create a KMS Customer-Managed Key (CMK) with key spec `ECC_NIST_P256` in `us-east-1` (Route 53 DNSSEC requires `us-east-1` for the KSK).
2. Enable DNSSEC on the zone; Route 53 publishes the DS record to add at the registrar.

Disabling DNSSEC requires removing the DS record at the registrar first; otherwise resolvers will treat the zone as bogus during the transition.

## Resolver

Route 53 Resolver is the per-VPC DNS resolver (`169.254.169.253` / `VpcCidr.2`). Two extension types:

- **Inbound endpoint** — receive DNS queries from on-prem into VPC. ENI(s) in a VPC subnet. On-prem forwards `*.internal.example.com` to the inbound endpoint IPs.
- **Outbound endpoint + Resolver Rules** — forward specific domains from VPC out to on-prem or to a custom resolver. ENI(s) in a VPC subnet. Common for hybrid AD or on-prem corporate domains.

Resolver Rules can be shared across accounts via AWS RAM.

## Private hosted zones + VPC associations

A private hosted zone is resolvable from any VPC explicitly associated with it. Cross-account VPC association requires authorization on the zone-owning account + accept on the VPC-owning account.

For PrivateLink workloads, the **interface endpoint's private DNS** uses the service's public name (e.g., `secretsmanager.us-east-1.amazonaws.com`) and resolves to the endpoint ENIs from inside the VPC. This works because the VPC's resolver auto-overrides the public AWS service DNS. Disabling the endpoint's "Enable private DNS name" breaks this — explicit private DNS zone (e.g., `privatelink.s3.region.vpce.amazonaws.com`) is needed instead.

## Common pitfalls

- **CNAME at zone apex** — invalid; use Route 53 alias or migrate DNS provider.
- **MX records with trailing dot** — Route 53 console accepts both; for `terraform aws_route53_record`, the value must include the trailing dot. Mismatches cause silent mail-routing failures.
- **TTL too high during a planned cutover** — drop TTL 24h+ before the cutover; raise back afterwards.
- **Private zone not associated with the VPC** — DNS lookups return public-zone records or NXDOMAIN. `aws route53 list-hosted-zones-by-vpc --vpc-id <id>` to audit.
- **Health check failing only from some locations** — check the 15 global checker locations health page; geographic checker downtime causes false unhealthies.
- **Domain registered at Route 53 but DNS pointed elsewhere** — confirm registrar name servers match the zone's `NS` records.
- **DNSSEC enabled but registrar DS missing or wrong** — zone goes bogus, resolvers reject all answers. Validate with `dig +dnssec` and `dnsviz.net`.
- **Forgetting that Route 53 health checks cost** — health-check per-endpoint per-month adds up across many failover records.

## First-party entry points

- Route 53 Developer Guide: `docs.aws.amazon.com/Route53/latest/DeveloperGuide/`
- Routing policies: `docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html`
- Alias records: `docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-choosing-alias-non-alias.html`
- Health checks: `docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover.html`
- DNSSEC: `docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-configuring-dnssec.html`
- Resolver: `docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver.html`
