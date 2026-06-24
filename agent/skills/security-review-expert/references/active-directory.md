# Active Directory / Entra ID / LDAP

## Legacy AD vs Entra ID distinction

| Scenario | Identity plane | Auth protocols | Risk profile |
|---|---|---|---|
| On-prem AD only | AD DS | Kerberos, NTLM, LDAP | Tier 0 on-prem |
| Hybrid (AD DS + Entra Connect) | Both | Modern + legacy | Attack paths span planes — AD compromise = Entra compromise |
| Cloud-only Entra ID | Entra ID | OIDC, OAuth 2.0, SAML | No legacy protocol surface by default |

Entra ID does not natively speak LDAP or Kerberos. Apps requiring LDAP must use Entra Domain Services (managed domain) or on-prem AD DS.

## LDAP simple bind

- LDAP simple bind on port 389 without TLS (STARTTLS or LDAPS port 636) sends credentials in cleartext — Critical.
- LDAP simple bind requires storing a long-lived service account password with no rotation enforcement by default.
- Modern auth (OIDC/OAuth 2.0) uses short-lived tokens and allows Conditional Access enforcement; LDAP simple bind bypasses CA. Flag any new design that chooses LDAP simple bind when OIDC is feasible.
- Entra Domain Services Secure LDAP must be explicitly configured with a certificate and restricted to known IP ranges if exposed to the internet.

## Hybrid identity flows

| Method | Mechanism | Key risk |
|---|---|---|
| Password Hash Sync (PHS) | Hash-of-hash synced to Entra ID | On-prem password compromise reflected within sync cycle |
| Pass-Through Auth (PTA) | Auth forwarded to on-prem via lightweight agent | PTA agent host is Tier 0 — agent compromise = credential validation manipulation |
| Federation (AD FS) | Entra trusts AD FS STS | AD FS / WAP servers are Tier 0; token-signing cert compromise = arbitrary token minting |

- PTA agents on domain controllers — should run on dedicated member servers.
- Fewer than 3 PTA agents — resilience minimum.
- PHS as resilience backstop even when PTA/Federation is primary.
- Entra Connect server treated as Tier 0 — must not run on a DC or shared-purpose server.

## Service account hygiene

- AD DS: prefer Group Managed Service Accounts (gMSA) over traditional accounts — automatic password rotation.
- AD service accounts with non-expiring passwords that are not gMSAs.
- Service accounts in `Domain Admins` or `Enterprise Admins`.
- Entra ID: user accounts used as service accounts cannot satisfy mandatory MFA in automation.

## Kerberos delegation

| Type | Risk | Pattern to flag |
|---|---|---|
| Unconstrained | Cached TGTs of any authenticating user | Any non-DC computer with `TrustedForDelegation = true` |
| Constrained (traditional) | Source can impersonate any user to listed SPNs | Verify SPN list is minimal and excludes DC SPNs |
| RBCD | Controlled by target's `msDS-AllowedToActOnBehalfOfOtherIdentity` | Accounts with `GenericWrite` / `WriteDacl` / `AllExtendedRights` on computer objects outside expected delegation paths |

Privileged accounts (Domain Admins, Enterprise Admins, Account Operators) must have `Account is sensitive and cannot be delegated` set.

## Tier 0 / Control Plane isolation

Domain Controllers, AD DS, Entra Connect, AD FS / WAP, PTA agents, PKI/CA roots, Entra Global Administrator accounts, Privileged Access Workstations.

- Tier 0 must not be reachable from Tier 1/2 administrative accounts. Flag jump-server patterns that allow pivot from Tier 1 to Tier 0.
- Global Administrator accounts must be cloud-only, used only from PAWs, and PIM-bounded.
- Fewer than 2 break-glass accounts, or break-glass accounts enrolled in CA policies.
