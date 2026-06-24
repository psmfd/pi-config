# AWS MSK (Managed Streaming for Kafka)

## Provisioned vs Serverless

| | Provisioned | Serverless |
|---|---|---|
| Billing | Per-broker-hour + storage GB-month | Per-throughput (in/out GB) + per-partition-hour |
| Scaling | Manual (broker count, broker size) + storage autoscaling | Automatic up to current MSK Serverless throughput quotas (verify limits at `docs.aws.amazon.com/msk/latest/developerguide/limits.html`) |
| **Auth** | IAM, SASL/SCRAM, mTLS, or unauthenticated (private only) | **IAM only** |
| **Authz** | Kafka ACLs (when SASL/SCRAM or mTLS) **or** IAM | IAM only |
| Encryption in transit | TLS, plaintext (intra-VPC only) | TLS only |
| Encryption at rest | AWS-managed KMS or CMK | AWS-managed KMS |
| MSK Connect | Yes | Yes |
| Public access | Optional (Provisioned only) — strongly discouraged | No public access |
| Multi-VPC connectivity | PrivateLink (M5+ instances) | PrivateLink |
| Latency-sensitive workloads | Low (dedicated brokers) | Higher tail latency (multi-tenant) |

**Default recommendation**:

- Use **Serverless** for variable / unpredictable throughput where IAM-only auth is acceptable.
- Use **Provisioned** for sustained high throughput, SASL/SCRAM or mTLS auth requirements, sub-millisecond consumer lag SLAs, or workloads that pin to specific broker resources.

## Broker sizing (Provisioned)

| Class | Use |
|---|---|
| `kafka.t3.small` | Dev / testing only |
| `kafka.m5.large` → `m5.24xlarge` | Standard production |
| `kafka.m7g.large` → `m7g.16xlarge` | Graviton (cheaper); current default for greenfield |
| `kafka.express.m7g.*` | Express brokers (3× throughput, lower latency); newer |

Broker count must be a multiple of the AZ count (typically 3 or 6 for 3-AZ deployments). Replication factor (`min.insync.replicas`) and partition count determine effective throughput.

## Authentication options

| Method | Use |
|---|---|
| **IAM** | AWS-native; uses SigV4. Default for AWS-only consumers/producers. Authz via IAM policies. Works on Provisioned + Serverless. |
| **SASL/SCRAM** | Username + password stored in Secrets Manager. Good for on-prem clients that can't use IAM. Authz via Kafka ACLs. |
| **mTLS** | Client certificates via ACM Private CA. High-trust environments. Authz via Kafka ACLs (using cert DN). |
| **Unauthenticated** | TCP-only, intra-VPC. Avoid except dev. |

**Multiple methods can be enabled simultaneously** on a Provisioned cluster — common pattern is IAM (for AWS workloads) + SASL/SCRAM (for on-prem). Serverless is IAM-only.

## Authorization — Kafka ACLs vs IAM

| | Kafka ACLs | IAM |
|---|---|---|
| Grant model | `kafka-acls.sh --add --topic <t> --producer --consumer-group <g> --principal User:<u>` | IAM policy with `kafka-cluster:Connect` / `WriteData` / `ReadData` on resource ARN |
| Wildcards | Topic prefix, group prefix | ARN-level wildcards |
| Audit trail | Kafka logs (not CloudTrail) | CloudTrail |
| Cross-account | Hard (cert/secret distribution) | Easy (cross-account IAM) |
| Native to Kafka ecosystem | Yes | No (AWS-specific) |

**Recommendation**: IAM for greenfield AWS-only; Kafka ACLs when you need a portable Kafka authz model or you have non-AWS consumers.

## Encryption

- **In transit**: TLS between brokers always on. TLS between clients and brokers configurable (Provisioned can allow plaintext intra-VPC; Serverless is TLS-only).
- **At rest**: AWS-managed KMS by default. Customer-managed CMK supported for compliance.
- **Inter-broker** TLS: always on (no opt-out).

## MSK Connect

Managed Kafka Connect runtime. Connector plugins are uploaded to S3 then referenced in the connector config. Common plugins:

- Debezium (CDC from RDS / Aurora / DynamoDB Streams)
- S3 sink
- OpenSearch sink
- Kinesis Data Firehose sink

MSK Connect bills per worker-MCU per hour. Mind the worker count — autoscaling has a `min`/`max` bound; if `min` is too high you pay for idle workers.

## Schema Registry

AWS Glue Schema Registry integrates with MSK clients (Java, .NET, Python via `aws-glue-schema-registry`). Schema evolution rules: BACKWARD (default), FORWARD, FULL, NONE. Pin the schema rule before deploying producers; switching rules later is painful.

Confluent Schema Registry on a separate EC2 / EKS is an alternative if you have existing Confluent tooling.

## Client config gotchas

```properties
# IAM auth (Provisioned or Serverless)
security.protocol=SASL_SSL
sasl.mechanism=AWS_MSK_IAM
sasl.jaas.config=software.amazon.msk.auth.iam.IAMLoginModule required;
sasl.client.callback.handler.class=software.amazon.msk.auth.iam.IAMClientCallbackHandler

# Bootstrap brokers
bootstrap.servers=b-1.cluster.abc123.c2.kafka.us-east-1.amazonaws.com:9098,...
```

- **Bootstrap port** differs per auth: `9092` (plaintext), `9094` (TLS), `9096` (SASL/SCRAM), `9098` (IAM). Wrong port → connection refused.
- **`bootstrap.servers` must list multiple brokers** for failover; a single broker is a single point of failure even though Kafka is distributed.
- **Required client library version** for IAM: `aws-msk-iam-auth` 1.1.5+. Older versions don't support all client config patterns.
- **librdkafka** (used by Python `confluent-kafka`, Go `confluent-kafka-go`) requires the `oauthbearer` token provider integration for IAM. Java has native support via the `aws-msk-iam-auth` JAR.

## Common pitfalls

- **MSK Serverless with non-IAM client** — only IAM. SASL/SCRAM clients can't connect. If you need SASL/SCRAM, use Provisioned.
- **Wrong port for the auth method** — see above. `9098` for IAM, `9096` for SASL/SCRAM, `9094` for TLS.
- **Security group missing for the auth port** — clients must be allowed to reach broker port from their subnet/SG. Allow inbound `9098` (IAM) from the producer/consumer SG.
- **`min.insync.replicas` = `replication.factor`** — any broker outage stops writes. Use `replication.factor=3` + `min.insync.replicas=2` for 1-broker tolerance.
- **Partition count too low** — Kafka parallelism is per-partition; consumers can't scale past partition count. Default 3-broker cluster usually wants 9+ partitions per topic.
- **Storage autoscaling not enabled** — Provisioned cluster runs out of storage; producers start failing. Enable `aws kafka update-broker-storage-info` with `STORAGE_GB` autoscaling target.
- **Replication factor < 3 in production** — single broker loss = data loss.
- **Public access enabled "temporarily"** — every accepted MSK security incident in customer postmortems involves this. Use PrivateLink for cross-VPC; never public access.
- **MSK Connect plugins from arbitrary S3 paths** — anyone with `kafka:CreateConnector` can supply a malicious plugin. Tight IAM on `kafka:CreateConnector` + S3 bucket policy restricting which buckets can be referenced.
- **Schema Registry version mismatch** — producer pushes new schema with FULL compatibility but a consumer pinned to an old schema-registry library doesn't understand the new schema. Pin library versions across all consumers; coordinate schema evolution.

## First-party entry points

- MSK Developer Guide: `docs.aws.amazon.com/msk/latest/developerguide/`
- MSK Serverless: `docs.aws.amazon.com/msk/latest/developerguide/serverless.html`
- IAM auth: `docs.aws.amazon.com/msk/latest/developerguide/iam-access-control.html`
- SASL/SCRAM: `docs.aws.amazon.com/msk/latest/developerguide/msk-password.html`
- mTLS: `docs.aws.amazon.com/msk/latest/developerguide/msk-authentication.html`
- MSK Connect: `docs.aws.amazon.com/msk/latest/developerguide/msk-connect.html`
- Schema Registry (Glue): `docs.aws.amazon.com/glue/latest/dg/schema-registry.html`
- Client `aws-msk-iam-auth`: `github.com/aws/aws-msk-iam-auth`
