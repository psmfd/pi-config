# AWS VPC Networking

## Subnet roles

| Subnet type | Public IP auto-assign | Route to IGW | Use |
|---|---|---|---|
| Public | Yes | Yes (via IGW) | Load balancers, bastion, NAT Gateway |
| Private (with NAT) | No | 0.0.0.0/0 → NAT | Workloads needing outbound internet |
| Private (no NAT) | No | No 0.0.0.0/0 | Workloads with only VPC Endpoint egress (cheaper, more secure) |
| Isolated | No | No route off-subnet except via TGW/peering | RDS, internal-only |

Workloads should be private-by-default. Public subnets are for things that need to be reachable from the internet (load balancers, NAT). Workloads themselves should be in private subnets behind load balancers.

## Route tables

- One main route table per VPC (default association).
- Subnets can be explicitly associated with a different route table to override.
- Routes are evaluated **most-specific first** (longest prefix match).
- The implicit local route (the VPC CIDR) cannot be removed or overridden.
- Edge associations (IGW, virtual private gateway) attach route tables to gateway traffic for inbound rewrite — used for transparent firewalling via Gateway Load Balancer.

## NAT Gateway vs NAT Instance vs VPC Endpoints

| Option | When |
|---|---|
| **NAT Gateway** | Production. Managed, multi-AZ if you create one per AZ. **Cost**: hourly + per-GB data-processing fee. Cross-AZ NAT use is the most common cost trap — each AZ should have its own NAT in private subnets routing to it. |
| **NAT Instance** | Niche. Legacy. Only consider for low-traffic dev with a hard cost cap. |
| **VPC Gateway Endpoint** (S3, DynamoDB only) | **Free**. Use whenever you only need S3/DynamoDB egress from private subnets — avoids NAT entirely. |
| **VPC Interface Endpoint** (PrivateLink — every other AWS service) | Hourly + per-GB (no data-processing fee), per-AZ ENI. Cheaper than NAT for any per-service workload > a few GB/month. |

**Rule of thumb**: if a private workload only talks to AWS APIs, you don't need NAT at all — use endpoints.

## VPC Endpoints (PrivateLink)

- **Gateway** endpoints: S3, DynamoDB. Free, no ENI, routed via route-table entries.
- **Interface** endpoints: everything else. ENIs in chosen subnets, charged per AZ-hour + per-GB.
- **Endpoint policy** is an IAM policy that scopes what calls the endpoint will forward — default is `*`; tighten to specific buckets/secrets/roles.
- Private DNS (enabled by default for Interface endpoints) replaces the public service name resolution inside the VPC — `secretsmanager.us-east-1.amazonaws.com` resolves to the endpoint ENIs instead of the public IPs.
- Cross-account / cross-Region access: PrivateLink can publish a service from one account/Region to consumers in others.

## Security Groups vs NACLs

| Aspect | Security Group | NACL |
|---|---|---|
| Scope | Per-ENI | Per-subnet |
| State | Stateful (return traffic auto-allowed) | Stateless (return traffic needs explicit rule) |
| Rules | Allow only | Allow + Deny |
| Evaluation | All rules evaluated, allow if any match | Numbered, first-match wins |
| Default | Deny all in, allow all out | Allow all both ways |

Use **security groups for workload-level controls** and treat NACLs as a coarse fallback (e.g., subnet-wide block of a known-bad CIDR). Don't try to do per-port micro-segmentation with NACLs; it's painful and harder to audit.

Security groups can reference **other security groups** as sources — this is the idiomatic way to allow "any pod in the workers SG to reach the database SG on port 5432." Avoid CIDR-based rules between AWS resources when SG references work.

## Transit Gateway (TGW) vs VPC Peering vs Direct Connect

- **VPC Peering** — point-to-point, non-transitive, no overlap allowed. Fine for 2–3 VPC topologies; doesn't scale.
- **Transit Gateway** — hub-and-spoke for many VPCs, on-prem (via VPN or DX), and other Regions (via TGW peering). Routes are per-attachment per route table. The right choice once you have > 3 VPCs.
- **Direct Connect** — dedicated physical or VLAN connection to on-prem. Private VIFs for VPC access, Public VIFs for AWS public endpoints, Transit VIFs for TGW. DX Gateway aggregates multiple DX connections.
- **Site-to-Site VPN** — IPsec over the internet to a VGW or TGW. Use as DX backup or for non-critical hybrid.

TGW data-processing fee per GB is on top of the cross-AZ / cross-Region transfer cost. Multi-Region TGW topologies need careful cost modeling.

## VPC Flow Logs

- Per-ENI, per-subnet, or per-VPC.
- Destination: CloudWatch Logs (expensive at scale), S3 (cheaper, queryable via Athena), or Kinesis Data Firehose.
- Default fields: action (ACCEPT/REJECT), srcaddr, dstaddr, srcport, dstport, protocol, packets, bytes, start, end.
- Custom format adds VPC ID, subnet ID, instance ID, TCP flags, traffic-type (ingress/egress), pkt-srcaddr (post-NAT), etc.
- **REJECT logs** are the security-relevant signal — blocked-by-SG/NACL connections worth investigating.

## Reachability Analyzer + Network Access Analyzer

- **Reachability Analyzer** — point-to-point connectivity test ("can this ENI reach this RDS?"). Returns hop-by-hop path or the specific config that blocks.
- **Network Access Analyzer** — declarative "find all paths matching this pattern" (e.g., "any internet-reachable path to a database subnet"). Use for periodic audit of unintended exposure.

## Common pitfalls

- **NAT in only one AZ** with workloads in multiple AZs — single point of failure + cross-AZ NAT cost. One NAT per AZ in production.
- **Forgetting S3 / DynamoDB Gateway Endpoints** — paying NAT data-processing for S3 traffic that could be free.
- **Endpoint policy on Interface Endpoint set to `*`** — passes through every IAM action; usually fine since IAM is also in effect, but tighten where it matters (e.g., secretsmanager endpoint policy scoped to specific secrets).
- **Security group with `0.0.0.0/0` on port 22 / 3389** — Bastion via SSM Session Manager (no inbound SG rule needed) is the modern alternative.
- **NACL rule numbering collision** during edits — first-match-wins, leave gaps (100, 200, 300) like AWS docs do.
- **VPC CIDR overlap** between VPCs you later want to peer — peering rejects overlapping CIDRs. Plan CIDR allocation centrally (RFC 6890, e.g., `10.0.0.0/8` partitioned by Region/account).
- **Private DNS for Interface Endpoint disabled** — clients still hit the public service IPs, and traffic egresses via NAT instead of staying on the private path. Audit with `dig` from inside the VPC.
- **Cross-AZ traffic on Inter-AZ-charged workloads** — measure with VPC Flow Logs + Athena; consider topology-aware routing (K8s `internalTrafficPolicy: Local`, Karpenter zone constraints).
- **TGW route table missing an attachment** — silent black hole. `aws ec2 describe-transit-gateway-route-tables` + `search-transit-gateway-routes` to audit.

## First-party entry points

- VPC User Guide: `docs.aws.amazon.com/vpc/latest/userguide/`
- VPC Endpoints (PrivateLink): `docs.aws.amazon.com/vpc/latest/privatelink/`
- Security groups: `docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html`
- NACLs: `docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html`
- Transit Gateway: `docs.aws.amazon.com/vpc/latest/tgw/`
- Flow Logs: `docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html`
- Reachability Analyzer: `docs.aws.amazon.com/vpc/latest/reachability/`
