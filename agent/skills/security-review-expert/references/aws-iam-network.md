# AWS (IAM and networking)

## IAM

- Wildcard `Action`/`Resource` (`s3:*`, `Resource: "*"`) without compensating `Condition` keys.
- `NotAction` used to grant broad access by exclusion — frequently misunderstood as a deny mechanism.
- Trust policies with overly permissive `Principal` (`"*"`) or missing `aws:SourceArn` / `aws:SourceAccount` / `aws:PrincipalOrgID` / `ExternalId`.
- STS session policies passed at `AssumeRole` — they intersect (not append) with the role's identity policy. Often misunderstood as additive.
- Permission boundaries vs SCPs vs identity policies — effective permission is the intersection across all four (identity, resource, boundary, SCP). Reasoning across these is in scope; effective-permission computation at scale belongs to AWS Access Analyzer.
- IAM users with long-lived access keys when IAM Identity Center / federation would suffice.

## S3

- Account-level Block Public Access disabled.
- Bucket-level BPA disabled with bucket policies relying on `Effect: Deny` rules that are easy to misread.
- Server-side encryption: `SSE-KMS` with CMKs preferred over `SSE-S3` for sensitive workloads; `SSE-C` shifts key responsibility to the client.
- Presigned URL expiry > 12h or unbounded.
- VPC endpoint policies missing — even when bucket policy is correct, traffic from VPC may bypass intended path.

## Networking

- Public/private subnet boundaries correct (NAT GW vs Internet GW correctly placed).
- Security Groups with default egress 0.0.0.0/0 — least-privilege egress is a mature-stage control.
- VPC endpoints (gateway vs interface) with policies that allow `*` action — endpoint policies should mirror least privilege.
- AWS Network Firewall vs Security Groups — Network Firewall is stateful and inspects URL/TLS SNI; SGs are stateless to L7 content.
- Route 53 Resolver DNS firewall in front of egress for malicious domain blocking.

## Secrets / KMS

- Secrets Manager preferred over SSM Parameter Store SecureString for rotation support.
- KMS key policies with wildcard `Principal` — even with Condition keys, this is an audit signal.
- KMS grants vs key policy — grants are revocable but harder to audit; prefer key policy for durable access.
- Automatic rotation enabled; multi-region keys for cross-region failover.

## Federation

- SAML vs OIDC — SAML attribute mapping pitfalls (case sensitivity, role-attribute injection).
- IdP-initiated vs SP-initiated SSO — IdP-initiated is more vulnerable to replay if not paired with audience restriction.
- IAM Identity Center integration — preferred over per-account SAML federation.

## Lambda / API Gateway

- Execution role least privilege — frequently inherits broad CloudWatch + dependent service access.
- API Gateway authorizer: Lambda authorizer caching can mask invalidation; Cognito authorizer simpler when usable.
- Resource policy vs IAM auth — both can be in effect; reasoning over the union is in scope.

## CloudTrail

- Multi-region trail required; single-region misses cross-region API calls.
- Log file integrity validation enabled.
- S3 bucket holding trail logs must itself have BPA, encryption, and a deny-delete policy.

## EC2 / IMDS

- IMDSv2 required (`HttpTokens: required`) on all instances; v1 fallback is exploitable via SSRF.
- EBS encryption-by-default at the regional level.
- Snapshot sharing via cross-account permissions can leak data — flag any shared snapshots without explicit allowlist.

## Out of scope — escalate to AWS-native tooling

- Effective-permission computation across SCP + boundary + identity + session — AWS IAM Access Analyzer
- Reachability analysis for unused access — Access Analyzer external/unused access analyzer
- Sensitive data discovery in S3 — Amazon Macie
- Compliance posture scoring — AWS Security Hub (CIS / PCI / NIST baselines)
- Runtime threat detection — Amazon GuardDuty
- Cost/configuration broad checks — AWS Trusted Advisor

## First-party entry points (AWS)

- IAM best practices: `docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html`
- IAM trust policies and conditions: `docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html`
- S3 security best practices: `docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html`
- KMS key policies: `docs.aws.amazon.com/kms/latest/developerguide/key-policies.html`
- VPC security: `docs.aws.amazon.com/vpc/latest/userguide/vpc-security.html`
- AWS Security Reference Architecture: `docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture/welcome.html`
- AWS Well-Architected Security Pillar: `docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html`
- IAM Access Analyzer: `docs.aws.amazon.com/IAM/latest/UserGuide/what-is-access-analyzer.html`
- IMDSv2: `docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html`
- CloudTrail security best practices: `docs.aws.amazon.com/awscloudtrail/latest/userguide/best-practices-security.html`
- Lambda security best practices: `docs.aws.amazon.com/lambda/latest/dg/security-best-practices.html`
