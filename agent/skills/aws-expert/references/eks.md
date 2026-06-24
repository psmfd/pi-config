# AWS EKS

## Cluster creation paths

| Tool | When |
|---|---|
| `eksctl` | Fastest greenfield; handles OIDC provider, node groups, addons in one declarative YAML |
| Terraform (`terraform-aws-eks` module) | IaC standard; widely audited; the canonical way to manage EKS at scale |
| CloudFormation / CDK | First-party but verbose for EKS specifically |
| Console / `aws eks create-cluster` | Click-ops; not recommended for anything beyond throwaway dev |

A bare `aws eks create-cluster` call does **not** create the node groups, OIDC provider, addons, or aws-auth config. `eksctl create cluster` does, which is why it's the default greenfield recommendation.

## Control plane vs data plane

- **Control plane** — AWS-managed (you don't have shell access). $0.10/hr per cluster, every cluster, every hour, regardless of activity.
- **Data plane** — your nodes. Three flavors:

| Flavor | Notes |
|---|---|
| Managed node groups | EC2 Auto Scaling Groups managed by EKS. Default choice. Supports launch templates for custom AMIs. |
| Self-managed nodes | Bring-your-own ASG. Use for niche AMIs, custom kubelet args, or special instance types. |
| Fargate | Per-pod billing, no nodes to manage. Limitations: no DaemonSets, no privileged pods, no EBS volumes, no GPU, slower pod start. Good for spiky low-throughput workloads. |

## Cluster autoscaling — Cluster Autoscaler vs Karpenter

| | Cluster Autoscaler | Karpenter |
|---|---|---|
| Model | Scales existing ASGs | Schedules nodes directly (no ASG) |
| Latency | Slow (ASG launch path) | Fast (direct EC2 fleet API) |
| Instance flexibility | One instance type per ASG | Any instance type per provisioner |
| Cost optimization | Manual (multiple ASGs per type) | Automatic (binpacking + spot/on-demand mix) |
| Recommendation | Legacy or strict ASG-based workflows | **AWS-recommended for greenfield clusters** (`karpenter.sh` is the AWS-maintained project; Cluster Autoscaler remains supported) |

Karpenter requires its own IAM role + node role + InstanceProfile and an SQS queue for spot interruption handling. Helm chart is the canonical install path.

## Add-ons

EKS Add-ons are AWS-managed installations of common cluster components:

- **VPC CNI** (`vpc-cni`) — pod networking. Configure prefix delegation for higher pod-per-node density.
- **CoreDNS** — cluster DNS. Replaces `kube-dns`.
- **kube-proxy** — service routing.
- **Amazon EBS CSI driver** — `PersistentVolume` provisioner for EBS.
- **Amazon EFS CSI driver** — EFS-backed PVs.
- **EKS Pod Identity Agent** — required if using Pod Identity (vs IRSA).
- **Amazon GuardDuty agent** — runtime threat detection (optional).

Manage via `aws eks describe-addon-versions` / `update-addon`. The Add-on path is preferred over `kubectl apply -f` because EKS handles upgrade compatibility.

## Identity — IRSA vs Pod Identity

See [`iam.md`](iam.md) for the IAM-side details. Briefly:

- **IRSA** — per-cluster OIDC provider in IAM; IAM role trust policy includes the OIDC issuer + service-account subject; ServiceAccount annotated with role ARN. Works without an agent.
- **Pod Identity** (GA 2023) — `pods.eks.amazonaws.com` service principal; per-cluster agent (the `eks-pod-identity-agent` addon) injects credentials; Association resource links role to namespace+SA. Simpler trust policies; no OIDC dance.

For **greenfield** clusters, default to Pod Identity. Existing IRSA setups work fine; migrate only if trust-policy maintenance is a friction point.

## Cluster authentication — `aws-auth` ConfigMap vs Access Entries

`aws-auth` ConfigMap (legacy): in the `kube-system` namespace, maps IAM ARNs to Kubernetes groups. A malformed entry can lock everyone — including admins — out of the cluster. Recovery requires the cluster-creator IAM identity (a single point of failure).

**Access Entries** (GA late 2023): IAM-side API, no in-cluster ConfigMap. `aws eks create-access-entry` + `associate-access-policy`. Greenfield clusters should set `authenticationMode: API_AND_CONFIG_MAP` and migrate progressively, then move to `API` once everything is on Access Entries.

```bash
# create access entry for an IAM role
aws eks create-access-entry \
  --cluster-name <c> \
  --principal-arn arn:aws:iam::ACCT:role/PlatformAdmin \
  --type STANDARD

# attach a managed access policy
aws eks associate-access-policy \
  --cluster-name <c> \
  --principal-arn arn:aws:iam::ACCT:role/PlatformAdmin \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster
```

## Networking

- VPC CNI assigns one ENI per node + additional secondary IPs per pod from the VPC subnet pool. Pod IPs are **VPC-routable** — no overlay.
- Subnet CIDR exhaustion is the most common EKS networking failure mode. Use `/22` or larger for pod subnets; consider **Custom Networking** + **IPv6** for very large clusters.
- **Network Policy** support: VPC CNI supports NetworkPolicy natively since 2023; older clusters relied on Calico add-on.
- LoadBalancer Service type provisions a NLB or ALB (via the AWS Load Balancer Controller). Install the controller via Helm; it needs IRSA/Pod Identity with `elasticloadbalancing:*`-scoped permissions.

## Common pitfalls

- **Forgetting the OIDC provider for IRSA** — `eksctl utils associate-iam-oidc-provider` or the equivalent IaC. Without it, IRSA silently fails (`sts:AssumeRoleWithWebIdentity` invalid).
- **`aws-auth` ConfigMap edited incorrectly** — locks out everyone except the cluster creator. Use Access Entries to avoid this single point of failure.
- **Subnet CIDR exhaustion** — VPC CNI assigns pod IPs from subnet pools; large clusters need `/22+`. Monitor `AvailableIPv4Addresses` per subnet.
- **EKS managed node group with custom AMI without a launch template** — use launch template + AMI ID; managed node groups support custom AMIs only via launch template.
- **Karpenter without spot interruption SQS** — pods get killed without graceful drain when AWS reclaims spot instances. Provision the SQS queue and configure Karpenter's interruption handler.
- **EBS CSI without IRSA/Pod Identity role** — PVC provisioning hangs at "WaitForFirstConsumer" then fails with `failed to provision volume with StorageClass`. The driver needs IAM to call EC2 EBS APIs.
- **Inter-AZ pod-to-pod traffic** — costs $0.01/GB each way. Use topology-aware routing or Karpenter zone constraints for cost-sensitive workloads.
- **Helm chart pinned to old API version** — `kubectl apply` succeeds but the workload misbehaves after a control-plane upgrade because the API version was removed. Use `kubent` (formerly `kube-no-trouble`) before each upgrade.
- **Fargate limitations underestimated** — no DaemonSet, no privileged, no GPU, no EBS, slower start, only Fargate-supported regions. Audit before recommending Fargate.

## First-party entry points

- EKS User Guide: `docs.aws.amazon.com/eks/latest/userguide/`
- `eksctl` docs: `eksctl.io` (third-party but maintained by AWS)
- IRSA: `docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html`
- Pod Identity: `docs.aws.amazon.com/eks/latest/userguide/pod-identities.html`
- Access Entries: `docs.aws.amazon.com/eks/latest/userguide/access-entries.html`
- Karpenter: `karpenter.sh` (project docs — AWS-maintained)
- AWS Load Balancer Controller: `kubernetes-sigs.github.io/aws-load-balancer-controller/`
