# Azure Key Vault

## Access Models — RBAC vs Access Policies

| Mode | How permissions are granted | Precedence |
|---|---|---|
| Azure RBAC (recommended) | Built-in roles like `Key Vault Secrets User`, `Key Vault Administrator` | When RBAC is enabled, access policies are **ignored** |
| Access Policies (legacy) | Per-principal lists of allowed operations (get/list/set for secrets, keys, certs separately) | Only consulted when RBAC is not enabled |

**Critical pitfall:** switching a vault from access policies to RBAC is an all-or-nothing operation per vault. Once RBAC is enabled (`enableRbacAuthorization: true`), existing access policies stop granting access — even if they remain defined in the resource. Confirm role assignments are in place **before** flipping the mode.

Common RBAC roles for data-plane access:

| Role | Scope |
|---|---|
| Key Vault Administrator | Full data-plane access (all secrets, keys, certs) |
| Key Vault Secrets Officer | Manage secrets (CRUD) |
| Key Vault Secrets User | Read secret values |
| Key Vault Crypto Officer | Manage keys |
| Key Vault Crypto User | Perform cryptographic operations |
| Key Vault Certificates Officer | Manage certificates |

## Private Endpoint Integration

Key Vault private endpoints require:

1. Disable public network access (`publicNetworkAccess: Disabled`) or restrict firewall to selected networks
2. Private endpoint in a subnet of your VNet
3. Private DNS zone `privatelink.vaultcore.azure.net` linked to the VNet with an A record for the vault's private IP
4. Client applications must resolve the vault's public FQDN (`<vault>.vault.azure.net`) to the private IP — the private DNS zone handles this via CNAME chain

**Trusted services bypass** allows some first-party Azure services (e.g., Azure Backup, Azure Disk Encryption) to reach the vault even with public access disabled — must be explicitly enabled, does not apply to all first-party services.

## Soft Delete and Purge Protection

- **Soft delete**: mandatory for all new vaults. Deleted vaults/secrets enter a recoverable state for 7-90 days (configurable).
- **Purge protection**: when enabled, nothing — including subscription owners — can purge a soft-deleted vault before the retention period expires. Cannot be disabled once enabled. Required for compliance workloads.
- Name collisions with soft-deleted vaults: you cannot create a new vault with the same name until the old one is purged or the retention expires.

## First-party entry points

- Key Vault overview: `learn.microsoft.com/azure/key-vault/general`
- RBAC guide: `learn.microsoft.com/azure/key-vault/general/rbac-guide`
- Private link: `learn.microsoft.com/azure/key-vault/general/private-link-service`
