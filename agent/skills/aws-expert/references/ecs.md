# AWS ECS

## Object hierarchy

```text
Cluster
  └── Service (long-running)
        └── Task (1 or more)
              └── Container (1 or more, from Task Definition)
  └── Standalone Task (one-off, e.g., from EventBridge or Step Functions)
```

A **Task Definition** is the template; a **Task** is a running instance; a **Service** keeps N tasks running and integrates with load balancers.

## Launch types — EC2 vs Fargate

| | EC2 | Fargate |
|---|---|---|
| Capacity | You manage EC2 instances (or Auto Scaling group) | Per-task; no instances to manage |
| Billing | EC2 hourly + EBS | Per-vCPU-second + per-GB-memory-second |
| Networking | `awsvpc` mode gives per-task ENI (same as Fargate); `bridge` and `host` modes share the instance ENI | `awsvpc` only |
| Privileged containers | Yes | No |
| GPU | Yes (with GPU AMIs) | No |
| Persistent storage | EBS volumes, instance store | EFS only (no EBS) |
| ECS Exec | Yes | Yes |
| Cold start | Instant (capacity already running) | Typically 15–30s task start (varies with image size and pull cache) |

**Fargate** is the default for variable / low-throughput workloads. **EC2** is the right choice for sustained workloads where you can amortize the instance cost across many tasks, or when you need privileged/GPU/EBS.

## Task IAM role vs Task Execution IAM role

This is the #1 ECS confusion point and worth knowing cold:

| Role | Used by | Purpose |
|---|---|---|
| **Task IAM role** | The application code | Calling AWS APIs from the workload (read S3, write DynamoDB, decrypt KMS) |
| **Task Execution role** | The ECS agent | Pull image from ECR, write logs to CloudWatch, retrieve secrets from Secrets Manager / SSM (when used for env injection) |

Both are required on the task definition. Missing Execution role → task fails to start with "essential container in task exited" because image pull or log driver setup failed. Missing Task role → workload runs but AWS API calls return AccessDenied.

```json
{
  "executionRoleArn": "arn:aws:iam::ACCT:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::ACCT:role/MyWorkloadRole",
  ...
}
```

The AWS-managed `AmazonECSTaskExecutionRolePolicy` is the standard execution-role policy (covers ECR pull + CloudWatch Logs). For Secrets Manager / SSM env injection, add `secretsmanager:GetSecretValue` / `ssm:GetParameters` scoped to the specific secrets.

## Networking modes

- **`awsvpc`** — per-task ENI in your VPC. **Required for Fargate**. Best isolation; one ENI per task uses your subnet IP pool.
- **`bridge`** — shared docker bridge on the EC2 instance. Port mappings via host port (or `0` for dynamic). EC2 only.
- **`host`** — task shares the host's network namespace. EC2 only. Niche.
- **`none`** — no networking. Niche.

## Service Discovery

| Option | When |
|---|---|
| **Cloud Map** (`aws-vpc-lattice` or `dns`) | First-party. DNS or HTTP-based. Use `dns` for internal A/SRV records. |
| **Service Connect** (newer, 2022) | First-party. Built-in Envoy sidecar provides east-west service mesh, retries, metrics. Recommended for greenfield. |
| **Load balancer (ALB/NLB)** | Standard for north-south traffic. ALB target group registered with the ECS service. |

## ECS Exec

`aws ecs execute-command --cluster <c> --task <t> --container <ct> --interactive --command /bin/sh`

Requires:

1. Task role with `ssmmessages:*` permissions.
2. Task definition `enableExecuteCommand: true`.
3. SSM Session Manager plugin installed locally.
4. For Fargate, platform version `LATEST` or ≥ `1.4.0`.

Sessions are logged to CloudWatch Logs or S3 (configurable per-cluster). Audit-trail-by-default for ECS Exec; SSH alternative for containers without inbound port exposure.

## Capacity providers

- **`FARGATE`** — on-demand Fargate.
- **`FARGATE_SPOT`** — Fargate with spot pricing (~70% off); interrupted with 2-minute warning.
- **Auto Scaling Group capacity providers** — your own ASGs registered as capacity providers; ECS scales them based on placement needs.

Mix Fargate + Fargate Spot in a capacity provider strategy for cost-optimized base + burst (e.g., `base: 2 on FARGATE, weight: 1 FARGATE / weight: 4 FARGATE_SPOT`).

## Deployments

| Type | Behavior |
|---|---|
| **Rolling update** (default) | Replace tasks in-place; respects `minimumHealthyPercent` + `maximumPercent` |
| **Blue/Green via CodeDeploy** | Two target groups; CodeDeploy swaps after health checks; supports canary and traffic-shifting |
| **External** | You orchestrate (rare) |

**Deployment circuit breaker** (`deploymentConfiguration.deploymentCircuitBreaker.enable: true`) auto-rolls back a rolling update if N consecutive task starts fail. Set `rollback: true` for fully-automatic rollback. Default-off historically; recommended-on for production services.

## Common pitfalls

- **Task IAM role vs Execution role mix-up** — see above. The #1 source of "my container can't read S3" / "my task won't start" support cases.
- **Forgetting `enableExecuteCommand`** — ECS Exec is opt-in per task definition, not on by default.
- **Fargate subnet IP exhaustion** — `awsvpc` gives every task an ENI; large clusters in small subnets run out of IPs. Use `/20+` per AZ.
- **Service deployment hung at "(steady state)" without actually being steady** — usually a health check mismatch (ALB health check path doesn't match container) or task failing repeatedly within the `minimumHealthyPercent` window so no progress is visible. Check `aws ecs describe-services` and CloudWatch task logs.
- **Secrets Manager injection without the right `secretsmanager:GetSecretValue` scope** — task fails to start with vague "ResourceInitializationError". Scope the execution role to the specific secret ARN.
- **Fargate Spot in stateful workloads** — 2-minute interruption is not enough for safe shutdown of long-running connections. Use on-demand for stateful tiers.
- **Service `desiredCount: 0` + capacity provider strategy** — capacity providers won't scale to zero correctly without ASG scaling-policy configuration; idle clusters can leave instances running.
- **Cross-AZ task placement without load-balancer cross-zone-balancing** — uneven traffic distribution. NLB cross-zone is off by default; ALB is on by default.
- **Mismatched platform version on Fargate** — newer features (Service Connect, ECS Exec) need recent platform versions; pinning to old version silently disables them.

## First-party entry points

- ECS Developer Guide: `docs.aws.amazon.com/AmazonECS/latest/developerguide/`
- Task IAM role: `docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html`
- Task Execution role: `docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html`
- Service Connect: `docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect.html`
- ECS Exec: `docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html`
- Capacity providers: `docs.aws.amazon.com/AmazonECS/latest/developerguide/cluster-capacity-providers.html`
- Deployment types: `docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-types.html`
