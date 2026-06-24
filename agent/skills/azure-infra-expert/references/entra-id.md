# Microsoft Entra ID

## Identity Principals

| Principal type | When to use | Notes |
|---|---|---|
| App registration | Custom applications that authenticate to other APIs | Produces a client ID and optional client secret/certificate; lives in a tenant, grants consent per tenant |
| Service principal | Representation of an app registration in a specific tenant | Created automatically at first consent or explicitly for SSO apps |
| System-assigned managed identity | Compute resources (VM, App Service, Function, Container Apps) calling other Azure APIs | Tied to the lifecycle of the resource; destroyed with the resource |
| User-assigned managed identity | Shared identity across multiple compute resources, or identity needed before resource exists | Independently managed lifecycle; reusable |
| Workload identity federation | External identity providers (GitHub Actions, Kubernetes SA) authenticating as an Entra app | Avoids long-lived secrets; preferred for CI/CD |

## RBAC

- Role assignments are scoped at **management group → subscription → resource group → resource**, with inheritance downward.
- **Deny assignments** take precedence over role assignments. Only Azure Blueprints and managed apps can create deny assignments (customers cannot author them directly via standard RBAC).
- **Propagation delay**: RBAC changes can take up to 5 minutes to propagate; rare long-tail delays of hours. Troubleshooting "access denied" immediately after an assignment should wait before assuming misconfiguration.
- Control-plane RBAC (management actions on resources) is distinct from data-plane RBAC (actions within a resource, like reading Key Vault secrets). Both may be required.

## Conditional Access

- Evaluated after authentication; policy evaluation is per-sign-in.
- Common signals: user/group, application, device state, sign-in risk, location.
- Common actions: require MFA, require compliant device, block access, grant with terms-of-use.
- **Emergency access accounts** ("break glass") must be excluded from every CA policy and stored with strict credential hygiene.

## First-party entry points

- Entra ID overview: `learn.microsoft.com/entra/identity`
- Managed identities: `learn.microsoft.com/entra/identity/managed-identities-azure-resources`
- Conditional Access: `learn.microsoft.com/entra/identity/conditional-access`
