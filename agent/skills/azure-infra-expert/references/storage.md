# Azure Storage Accounts

## Account Types and Data Services

| Account kind | Services | Notes |
|---|---|---|
| StorageV2 (general purpose v2) | Blob, File, Queue, Table | Default recommendation |
| BlockBlobStorage (Premium) | Blob only | Low-latency/high-throughput blob |
| FileStorage (Premium) | File only | SMB/NFS workloads |
| BlobStorage (legacy) | Blob only | Prefer StorageV2 |

## Redundancy

| SKU | Replicas | Failure domain |
|---|---|---|
| LRS | 3 copies in one zone | Rack failure |
| ZRS | 3 copies across zones in region | Zone failure |
| GRS | LRS + async copy to paired region | Region failure (manual failover for RA) |
| RA-GRS | GRS with read-only secondary endpoint | Region failure, read-only fallback |
| GZRS | ZRS + async copy to paired region | Zone + region failure |
| RA-GZRS | GZRS with read-only secondary endpoint | Max durability |

## Networking

| Option | Behavior |
|---|---|
| Public access (default) | Reachable via `<account>.blob.core.windows.net` |
| Firewall with IP rules | Public endpoint retained, restricted by source IP |
| Service endpoints | VNet-bound identity used for firewall rules; traffic still via public endpoint |
| Private endpoints | Fully private — NIC in your VNet, private DNS zone resolution |

## ADLS Gen2

- Technically a feature flag (**hierarchical namespace**) on a StorageV2 account, not a separate account kind
- Enables directory semantics, POSIX-like ACLs, and the `dfs` endpoint in addition to the `blob` endpoint
- Once enabled at account creation, **cannot be disabled**
- Private endpoints must be created for both `blob` and `dfs` sub-resources separately (two private endpoints per account for full ADLS Gen2 coverage)

## Access — RBAC vs SAS

| Mechanism | When to use |
|---|---|
| Entra ID + RBAC (`Storage Blob Data Reader`, etc.) | Service-to-service, managed identity, internal apps |
| Account key | Legacy; avoid — full plane-level control |
| Service SAS / Account SAS | Time-bound external access, when Entra ID not possible |
| User delegation SAS | Entra-backed SAS; preferred over account SAS when possible |
| Stored access policies | SAS revocation mechanism; without one, SAS cannot be revoked until expiry |

## First-party entry points

- Storage overview: `learn.microsoft.com/azure/storage/common`
- Private endpoint: `learn.microsoft.com/azure/storage/common/storage-private-endpoints`
- ADLS Gen2: `learn.microsoft.com/azure/storage/blobs/data-lake-storage-introduction`
