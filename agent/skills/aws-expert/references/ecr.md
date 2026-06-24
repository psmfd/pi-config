# AWS ECR

## Private vs Public registries

| Registry | URL | Use |
|---|---|---|
| ECR Private | `<account>.dkr.ecr.<region>.amazonaws.com/<repo>` | Default. Per-region, per-account. IAM-controlled. |
| ECR Public (Gallery) | `public.ecr.aws/<alias>/<repo>` | Distribute images to anyone. One global namespace per account (`alias`). |

ECR Private is **per-Region** — an image in `us-east-1` is not visible in `eu-west-1`. Use replication if you need it.

## Authentication

Docker / Podman / containerd cannot use IAM credentials directly. The `aws ecr get-login-password` flow exchanges IAM creds for a 12-hour token:

```bash
aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
```

For long-running container daemons, the `amazon-ecr-credential-helper` integrates with Docker config to refresh automatically — preferred over scripting `get-login-password` in cron.

EKS / ECS / Lambda pulling from ECR: handled by the node/task **execution role** (not the workload role). Required IAM:

```json
{
  "Effect": "Allow",
  "Action": [
    "ecr:GetAuthorizationToken",
    "ecr:BatchCheckLayerAvailability",
    "ecr:GetDownloadUrlForLayer",
    "ecr:BatchGetImage"
  ],
  "Resource": "*"
}
```

`GetAuthorizationToken` cannot be scoped to a repo — it's account-wide. The other three can be scoped to specific repository ARNs.

## Repository policy (resource-based)

For cross-account or cross-Org pulls, attach a repository policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCrossAccountPull",
    "Effect": "Allow",
    "Principal": {"AWS": "arn:aws:iam::OTHER:root"},
    "Action": [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage"
    ]
  }]
}
```

The pulling account's IAM role still needs the same actions on its side (both IAM and resource policy must allow). Same logic as S3 cross-account.

## Lifecycle policies

Untagged images and old tagged images add up fast. Lifecycle policies expire by count or age:

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "expire untagged > 14 days",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 14
      },
      "action": {"type": "expire"}
    },
    {
      "rulePriority": 2,
      "description": "keep last 50 tagged",
      "selection": {
        "tagStatus": "tagged",
        "tagPrefixList": ["v"],
        "countType": "imageCountMoreThan",
        "countNumber": 50
      },
      "action": {"type": "expire"}
    }
  ]
}
```

Rules evaluated by priority; first match wins. Test with `aws ecr start-lifecycle-policy-preview` before applying.

## Image scanning

| Mode | Coverage | Cost |
|---|---|---|
| **Basic** | OS package CVEs only, on push | Free |
| **Enhanced** (Inspector) | OS + language packages (Java, Node, Python, Go, Ruby, .NET), continuous re-scan as new CVEs publish | Per-image-scan + per-image-month |

Enhanced scanning is the right default for production. Findings flow to Inspector and EventBridge — wire to a notification channel.

## Replication

Cross-Region (CRR) or cross-account (CAR) replication. Configured at the registry level (not per repository):

```json
{
  "rules": [{
    "destinations": [{"region": "eu-west-1", "registryId": "<account>"}],
    "repositoryFilters": [{"filter": "prod-", "filterType": "PREFIX_MATCH"}]
  }]
}
```

One-way only (no automatic merge-back). Charges: per-GB transfer + storage in destination.

## Pull-through cache

ECR can mirror public registries (Docker Hub, GitHub Container Registry, Quay, Kubernetes registry, Microsoft Container Registry) on-demand. First pull of `<account>.dkr.ecr.<region>.amazonaws.com/<cache-alias>/library/alpine` fetches from upstream and caches; subsequent pulls are served from the cache.

Benefits: bypass Docker Hub rate limits, avoid public-internet egress for nodes in private subnets (combine with ECR VPC Endpoint), get image scanning on cached images.

## OCI artifacts

ECR supports arbitrary OCI artifacts (Helm charts, OPA bundles, SBOMs, signing manifests) — not just container images. Push with `oras push` or `helm push oci://…`.

## Common pitfalls

- **Forgetting `ecr:GetAuthorizationToken`** on the execution role — pull fails with "no basic auth credentials." This action **must** be `Resource: "*"`.
- **Repository policy without matching IAM allow** in pulling account — both sides must allow. Cross-account silent failure.
- **No lifecycle policy** — storage cost grows linearly with builds. Default rule: expire untagged > 14 days, keep last N tagged.
- **Pull-through cache with too-permissive IAM** — clients can probe arbitrary upstream images; scope `ecr:CreateRepository` to the specific cache prefix.
- **ECR endpoint missing for private-subnet nodes** — pulls go via NAT data-processing fee. Provision `com.amazonaws.<region>.ecr.api` + `…ecr.dkr` Interface Endpoints + an S3 Gateway Endpoint (ECR uses S3 for layer storage).
- **Cross-account image tag immutability** — tag immutability is per-repository; mutable tags in a shared repo cause "I pulled v1.2 yesterday and it's different today" support cases. Set `imageTagMutability: IMMUTABLE` for release repos.
- **Replication latency** — eventual; minutes typically, but not synchronous. CD pipelines that push then immediately pull from the replicated region can race.

## First-party entry points

- ECR User Guide: `docs.aws.amazon.com/AmazonECR/latest/userguide/`
- ECR Public User Guide: `docs.aws.amazon.com/AmazonECR/latest/public/`
- Repository policies: `docs.aws.amazon.com/AmazonECR/latest/userguide/repository-policies.html`
- Lifecycle policies: `docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html`
- Image scanning: `docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning.html`
- Pull-through cache: `docs.aws.amazon.com/AmazonECR/latest/userguide/pull-through-cache.html`
- Credential helper: `github.com/awslabs/amazon-ecr-credential-helper`
