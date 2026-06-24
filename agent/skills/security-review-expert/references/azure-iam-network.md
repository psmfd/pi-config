# Azure (IAM and networking)

## Entra ID and RBAC

- Flag `Owner` or `Contributor` at subscription scope where a narrower role suffices. Distinguish control-plane (`Contributor`) from data-plane (`Storage Blob Data Reader`, `Key Vault Secrets User`) — assigning only one when both are required is a common gap.
- Service principals with Owner on a subscription — prefer system-assigned managed identities + scoped data-plane role.
- Role assignments directly on user accounts rather than groups.
- Permanent `Global Administrator` count > 3 is a finding; Microsoft floor is < 5.
- Permanent `User Access Administrator` rather than time-bounded via PIM.

## Conditional Access

- At least one policy blocking legacy authentication (BasicAuth, SMTP AUTH).
- Break-glass accounts excluded from every CA policy.
- Risk-based CA without Entra ID P2 license — flag the configuration mismatch.

## PIM and managed identities

- Permanent active assignments in roles that PIM supports when PIM is licensed.
- System-assigned MI when the identity should match resource lifecycle; user-assigned when the identity is shared or pre-exists the resource.
- User-account service principals cannot satisfy mandatory MFA in automation flows (Phase 2 enforcement effective October 2025).

## Key Vault

- `enableRbacAuthorization: true` on all vaults; legacy access policies do not support PIM and have privilege enumeration issues.
- `publicNetworkAccess: Disabled` with private endpoint and `privatelink.vaultcore.azure.net` zone.
- `enableSoftDelete: true` with 90-day retention; `enablePurgeProtection: true` for vaults holding storage/disk encryption keys (irreversible, intentionally).
- Secrets without expiry dates.
- Diagnostic settings streaming `AuditEvent` to Log Analytics or Event Hub.

## Storage

- `allowSharedKeyAccess: false` for managed-identity-only access.
- `publicNetworkAccess: Disabled` with private endpoints for `blob` and `dfs` (two endpoints for ADLS Gen2).
- `allowBlobPublicAccess: false` unless intentionally serving anonymous content.
- CMK with `enablePurgeProtection: true` on the key vault — purging the vault key permanently breaks the storage account.
- Account-level SAS without a stored access policy cannot be revoked pre-expiry; prefer user-delegation SAS.
- ADLS Gen2 `isHnsEnabled` is immutable post-creation.

## Networking

- NSG rules with source `*` on management ports 22, 3389, 5985, 5986.
- Hub VNets routing internet traffic without Azure Firewall or NVA traversal.
- PaaS services in production (Key Vault, Storage, Service Bus, SQL, Cosmos DB) without private endpoints when public access is enabled.
- ExpressRoute private peering subnets without NSGs; Gateway subnets with user-defined routes (unsupported, breaks connectivity).
- Custom DNS without forwarding `168.63.129.16` for `privatelink.*` zones — private endpoint name resolution fails silently.

## Log Analytics / Azure Monitor

- Workspace lock (`CanNotDelete`) prevents accidental deletion but is removable; tamper-proof retention requires data export to immutable Storage with policy.
- `Monitoring Metrics Publisher` role on the DCR (not the workspace) for ingesting managed identity.
- AMA-only deployment; MMA was retired August 2024.
- Sentinel on a dedicated workspace, not shared multi-purpose.

## First-party entry points (Azure / AD / Entra)

- Azure identity best practices: `learn.microsoft.com/azure/security/fundamentals/identity-management-best-practices`
- MCSB v2 Identity Management: `learn.microsoft.com/security/benchmark/azure/mcsb-v2-identity-management`
- MCSB v2 Network Security: `learn.microsoft.com/security/benchmark/azure/mcsb-network-security`
- Entra security operations: `learn.microsoft.com/entra/architecture/security-operations-introduction`
- Securing privileged access: `learn.microsoft.com/entra/identity/role-based-access-control/security-planning`
- Key Vault best practices: `learn.microsoft.com/azure/key-vault/general/best-practices`
- Key Vault security features: `learn.microsoft.com/azure/key-vault/general/security-features`
- Private Endpoint overview: `learn.microsoft.com/azure/private-link/private-endpoint-overview`
- Private Endpoint DNS: `learn.microsoft.com/azure/private-link/private-endpoint-dns`
- Storage shared-key disable: `learn.microsoft.com/azure/storage/common/shared-key-authorization-prevent`
- Azure Monitor security: `learn.microsoft.com/azure/azure-monitor/fundamentals/best-practices-security`
- LDAP with Entra ID: `learn.microsoft.com/entra/architecture/auth-ldap`
