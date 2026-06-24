# AWS Elastic Beanstalk

## Deprecation posture

Be honest about Beanstalk's role in 2025+:

- It is not deprecated. New platforms still ship (e.g., Amazon Linux 2023 platforms), but most new AWS web-app guidance points at **App Runner** (fully managed containers, Heroku-like UX), **ECS Fargate** (more control, same managed-instance feel), or **EKS** (Kubernetes native).
- **When Beanstalk is the right answer**: existing Beanstalk workloads where migration cost > maintenance cost; teams that need PaaS without learning containers; tightly-coupled Beanstalk-extension shops (`.ebextensions` patterns) that would lose significant tooling on migration.
- **When it is the wrong answer**: greenfield container workloads (use App Runner / ECS / EKS); workloads needing per-pod IAM (Beanstalk doesn't have IRSA / Pod Identity); workloads needing fine-grained scheduling.

Surface this triage on any Beanstalk question — don't recommend it for greenfield without justification.

## Object hierarchy

```text
Application
  └── Application Version (artifact: .zip, .war, Docker image)
        └── Environment (one or more, e.g., dev/staging/prod)
              └── EC2 instances (managed via Auto Scaling Group)
              └── Load balancer (optional, classic/ALB/NLB)
```

Multiple environments per application share the application's source versions; each environment has its own URL, config, and instances.

## Environment tiers

| Tier | Topology | Use |
|---|---|---|
| **Web Server** | LB + ASG of EC2 | HTTP/HTTPS workloads |
| **Worker** | SQS queue + ASG of EC2 pulling messages | Background jobs; no public LB |

Web ↔ Worker environments are paired by convention — web environment pushes to an SQS queue that the worker environment polls.

## Platforms

A **Platform Version** is the bundle of OS + runtime + Beanstalk agent. Each platform has its own retirement schedule (`aws elasticbeanstalk list-platform-versions`). Current platforms include:

- Amazon Linux 2023 / Amazon Linux 2 (older)
- Node.js, Python, Ruby, Go, Java SE, Tomcat, .NET on Linux, .NET Core on Linux, PHP, Docker, Multi-container Docker (deprecated; use ECS instead), Packer-based custom platforms

**Platform Branches** auto-update within a major (e.g., Python 3.11 stays current). Cross-major upgrades (Python 3.11 → 3.12) are a migration, not an in-place update — test in staging first.

## `.ebextensions` and `.platform/`

Two extension mechanisms, both live in the source bundle:

| | `.ebextensions/*.config` | `.platform/hooks/` |
|---|---|---|
| Era | Legacy (Amazon Linux 1) | Current (Amazon Linux 2 / 2023) |
| Format | YAML with `commands`, `container_commands`, `files`, `packages`, `option_settings`, `services` | Shell / Python scripts in `prebuild/`, `predeploy/`, `postdeploy/` |
| Runtime root | `/` (system-level) | `/var/app/staging` (prebuild/predeploy), `/var/app/current` (postdeploy) |

For Amazon Linux 2 / 2023 platforms, prefer `.platform/hooks/`. `.ebextensions` still works for `option_settings` (the most-used feature) but the procedural extensions (`commands`, `container_commands`) are AL1-era and increasingly brittle on AL2/AL2023.

```text
.platform/
├── hooks/
│   ├── prebuild/
│   │   └── 01_install_native_deps.sh
│   ├── predeploy/
│   │   └── 01_migrate_db.sh
│   └── postdeploy/
│       └── 01_warm_cache.sh
└── nginx/
    └── conf.d/
        └── custom.conf
```

Hook scripts must be executable (`chmod +x` before zipping) — easy to forget when bundling on Windows or via CI.

## Configuration — `option_settings`

The canonical way to set environment configuration declaratively:

```yaml
option_settings:
  aws:autoscaling:asg:
    MinSize: 2
    MaxSize: 6
  aws:elasticbeanstalk:application:environment:
    DATABASE_URL: postgres://...
  aws:elasticbeanstalk:environment:
    EnvironmentType: LoadBalanced
  aws:autoscaling:launchconfiguration:
    IamInstanceProfile: aws-elasticbeanstalk-ec2-role
```

Settings have a precedence order: saved configurations > `.ebextensions` `option_settings` > settings in `aws elasticbeanstalk update-environment --option-settings` > template defaults. Per-namespace; `aws elasticbeanstalk describe-configuration-options` lists every option.

## Blue/Green deployments

Beanstalk does not have native Blue/Green — the pattern is:

1. Clone the production environment (`aws elasticbeanstalk swap-environment-cnames`-ready).
2. Deploy the new version to the clone.
3. Test.
4. `swap-environment-cnames` to swap the CNAMEs.
5. Terminate the old environment after a soak period.

Rolling and Rolling-with-additional-batch deployments are in-place alternatives — cheaper but riskier than Blue/Green.

## Managed updates

Beanstalk can auto-apply platform-version patches (`aws:elasticbeanstalk:managedactions`). Pin maintenance window + level (`patch` or `minor`). Test in a non-prod environment first; managed updates have caused production incidents in older platform versions.

## Common pitfalls

- **`.ebextensions` for an AL2/AL2023 platform with AL1-era patterns** — `commands` / `container_commands` semantics changed; what worked on AL1 platforms may silently no-op on AL2. Use `.platform/hooks/`.
- **Hook script not executable** — Beanstalk silently skips non-executable hooks. Always `chmod +x .platform/hooks/**/*.sh` before zipping.
- **`option_settings` for a namespace that doesn't exist on the current platform** — Beanstalk rejects on deploy with `Configuration validation exception`. `aws elasticbeanstalk describe-configuration-options --platform-arn <arn>` to see what's valid.
- **Default service role** (`aws-elasticbeanstalk-service-role`) **missing** — common after IAM cleanup. Recreate per the AWS-managed `AWSElasticBeanstalkEnhancedHealth` policy.
- **`aws-elasticbeanstalk-ec2-role`** **scoped too narrowly** — your application code needs additional IAM (S3, DynamoDB, etc.). Add managed policies or inline; the default profile only includes Beanstalk agent permissions.
- **No load-balancer health check on a custom path** — default `/` may return 200 even when the app is broken. Set `aws:elasticbeanstalk:application:healthcheckurl` to a real `/healthz` endpoint.
- **In-place rolling update with stateful in-memory session** — sessions are dropped as instances are replaced. Use sticky sessions or external session store (ElastiCache).
- **Platform retirement** — retired platforms stop receiving security updates. `aws elasticbeanstalk describe-platform-version` shows the support status. Plan migrations 60-90 days before retirement.
- **Migration to containers underestimated** — moving from Beanstalk to ECS/EKS requires reworking `.ebextensions` patterns (init scripts, sidecar config, nginx tweaks). Budget time accordingly.

## First-party entry points

- Elastic Beanstalk Developer Guide: `docs.aws.amazon.com/elasticbeanstalk/latest/dg/`
- Platforms: `docs.aws.amazon.com/elasticbeanstalk/latest/platforms/`
- `.ebextensions`: `docs.aws.amazon.com/elasticbeanstalk/latest/dg/ebextensions.html`
- `.platform/hooks`: `docs.aws.amazon.com/elasticbeanstalk/latest/dg/platforms-linux-extend.hooks.html`
- Option settings: `docs.aws.amazon.com/elasticbeanstalk/latest/dg/command-options.html`
- Managed updates: `docs.aws.amazon.com/elasticbeanstalk/latest/dg/environment-platform-update-managed.html`
- Platform retirement schedule: `docs.aws.amazon.com/elasticbeanstalk/latest/platforms/platforms-supported.html`
