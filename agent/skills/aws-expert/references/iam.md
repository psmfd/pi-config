# AWS IAM

## Core entities

| Entity | Purpose |
|---|---|
| User | Long-lived identity with optional access keys + console password. Prefer SSO over IAM users for humans. |
| Group | Container for users to receive shared policies. Not a principal itself. |
| Role | Assumable identity with short-lived credentials via STS. Default choice for workloads and federation. |
| Policy (managed) | Reusable JSON policy attached to users/groups/roles. AWS-managed vs customer-managed. |
| Policy (inline) | Embedded in a single principal. Use sparingly; harder to audit. |
| Permission boundary | Upper bound on effective permissions of a principal. Does **not** grant; only caps. |
| SCP (Organizations) | Org-level upper bound applied to all principals in member accounts including root. |
| Session policy | Per-AssumeRole upper bound passed at session start. |

Effective permission = (Identity policy ∪ Resource policy) ∩ Permission boundary ∩ SCP ∩ Session policy − explicit denies.

## Trust policies and AssumeRole

Trust policy specifies who can assume the role. Always require a `Condition` for external principals:

```json
{
  "Effect": "Allow",
  "Principal": {"AWS": "arn:aws:iam::OTHER:role/CallerRole"},
  "Action": "sts:AssumeRole",
  "Condition": {
    "StringEquals": {"sts:ExternalId": "shared-secret-from-out-of-band"}
  }
}
```

For same-Org cross-account, `aws:PrincipalOrgID` is preferred over `ExternalId`. The [Confused Deputy](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html) problem applies whenever a third party calls AWS on your behalf.

## IRSA (IAM Roles for Service Accounts) on EKS

Per-Pod IAM via the cluster's OIDC provider. Requirements:

1. EKS cluster has an OIDC issuer URL (always true for EKS ≥ 1.12).
2. IAM has an OpenID Connect provider registered for that issuer URL (one-time per cluster). `eksctl utils associate-iam-oidc-provider --cluster <name> --approve`.
3. IAM role's trust policy permits the cluster's OIDC provider to assume it, scoped to a specific namespace + service-account name:

   ```json
   {
     "Effect": "Allow",
     "Principal": {"Federated": "arn:aws:iam::ACCT:oidc-provider/oidc.eks.REGION.amazonaws.com/id/CLUSTERID"},
     "Action": "sts:AssumeRoleWithWebIdentity",
     "Condition": {
       "StringEquals": {
         "oidc.eks.REGION.amazonaws.com/id/CLUSTERID:sub":
           "system:serviceaccount:NAMESPACE:SERVICE_ACCOUNT_NAME",
         "oidc.eks.REGION.amazonaws.com/id/CLUSTERID:aud": "sts.amazonaws.com"
       }
     }
   }
   ```

4. ServiceAccount annotated `eks.amazonaws.com/role-arn: arn:aws:iam::ACCT:role/RoleName`.

The `:sub` condition is the critical guard — without it, **any** pod in the cluster can assume the role.

## Pod Identity (newer alternative to IRSA)

EKS Pod Identity (GA 2023) avoids the OIDC trust-policy dance by using a per-cluster agent. Trust policy uses `pods.eks.amazonaws.com`:

```json
{
  "Effect": "Allow",
  "Principal": {"Service": "pods.eks.amazonaws.com"},
  "Action": ["sts:AssumeRole", "sts:TagSession"]
}
```

Then create an Association: `aws eks create-pod-identity-association --cluster-name <c> --namespace <ns> --service-account <sa> --role-arn <arn>`. Greenfield clusters should prefer Pod Identity; existing IRSA works fine and need not be migrated unless trust-policy maintenance is a friction point.

## Permission boundaries vs SCPs

- **Permission boundary** is set by the account admin on a specific principal. Used to delegate IAM admin to teams while capping what their created principals can do. Does not affect existing principals retroactively.
- **SCP** is set at the Organization or OU level and applies to all principals in member accounts, including the account root user. SCPs are deny-by-default at the Org root if you replace `FullAWSAccess`.

## Condition keys worth knowing

| Key | Use |
|---|---|
| `aws:PrincipalOrgID` | Restrict to principals in your Organization |
| `aws:SourceVpce` | Restrict S3/secrets to a specific VPC Endpoint |
| `aws:SourceVpc` | Restrict to a specific VPC |
| `aws:SourceArn` | Restrict service-principal callers (SNS → SQS, Lambda → role) |
| `aws:SourceAccount` | Pair with `aws:SourceArn` for service-principal Confused Deputy defense |
| `aws:RequestedRegion` | Restrict actions to specific Region(s) |
| `aws:MultiFactorAuthPresent` | Require MFA for sensitive actions |
| `aws:ResourceTag/<key>` | ABAC — grant based on resource tag |
| `aws:PrincipalTag/<key>` | ABAC — grant based on principal tag |
| `kms:ViaService` | Restrict KMS use to specific service (e.g., `s3.REGION.amazonaws.com`) |

## Common pitfalls

- **Trust policy without `ExternalId` / `PrincipalOrgID` for cross-account** — Confused Deputy waiting to happen.
- **`Action: "*"` paired with `Resource: "*"`** — almost never correct. Use IAM Access Analyzer's policy generator on real CloudTrail data.
- **Permission boundary missing `iam:*` cap when delegating IAM admin** — delegated admins can grant themselves more than the boundary.
- **SCP replacing `FullAWSAccess` without a replacement allow-list** — instantly locks out everyone in the account, including root.
- **IRSA `:sub` condition missing or wildcarded** — any pod in the cluster can assume the role.
- **Inline policies on every role** — un-auditable. Prefer customer-managed policies that can be reused and version-controlled.
- **Long-lived access keys** — rotate via Access Analyzer's unused-credentials report; prefer roles + STS.

## First-party entry points

- IAM User Guide: `docs.aws.amazon.com/IAM/latest/UserGuide/`
- IAM JSON Policy Reference: `docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies.html`
- IAM Condition Keys (global): `docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html`
- IRSA: `docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html`
- Pod Identity: `docs.aws.amazon.com/eks/latest/userguide/pod-identities.html`
- SCPs: `docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html`
- Confused Deputy: `docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html`
