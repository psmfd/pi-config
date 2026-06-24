---
name: vcluster-expert
description: 'vCluster reference for the vcluster-expert subagent — lifecycle, vcluster.yaml, resource syncing, networking, topologies, licensing tiers, platform mgmt, CLI.'
disable-model-invocation: true
---

# vCluster Expert

Read-only reference for vCluster guidance — architecture, configuration, resource syncing, networking, CLI usage, deployment methods, licensing, and platform management.

## Architecture and Deployment Topologies

vCluster creates fully functional virtual Kubernetes clusters that run inside namespaces of a host cluster. Each virtual cluster has its own API server, controller manager, and data store.

| Topology | Host cluster required | Node isolation | CNI/CSI isolation | Best for |
|---|---|---|---|---|
| Shared nodes | Yes | No | No | Dev/test, CI/CD, cost optimization |
| Dedicated nodes | Yes | Yes | No | Production with node-level separation |
| Private nodes | Yes | Yes | Yes | Compliance, GPU workloads, regulated environments |
| Standalone | No | Yes | Yes | Bare metal, edge, "cluster one" problem |
| vind (Docker) | No | Yes | Yes | Local development, Docker-only environments |

### Shared Nodes

Tenant workloads coexist on the host node pool. The syncer translates workload resources to a dedicated namespace on the host. Maximum density, lowest overhead.

```yaml
sync:
  fromHost:
    nodes:
      enabled: false  # Default — use pseudo/fake nodes
```

### Dedicated Nodes

Node selectors enforce placement on a reserved subset of host nodes.

```yaml
sync:
  fromHost:
    nodes:
      enabled: true
      selector:
        labels:
          tenant: my-tenant
```

### Private Nodes

External nodes join the vCluster directly with their own CNI, CSI, and networking stack. Control plane communicates via Konnectivity tunneling. No resource syncing between virtual and host.

```yaml
privateNodes:
  enabled: true
controlPlane:
  service:
    spec:
      type: NodePort
networking:
  podCIDR: 10.64.0.0/16
  serviceCIDR: 10.128.0.0/16
```

### Standalone

Zero-dependency binary on bare metal or VMs. No host Kubernetes cluster required.

```yaml
controlPlane:
  standalone:
    enabled: true
    joinNode:
      enabled: true
  backingStore:
    etcd:
      embedded:
        enabled: true
privateNodes:
  enabled: true
```

### vind (vCluster in Docker)

Complete cluster in Docker containers with sleep/wake, automatic load balancers, and pull-through image cache via host Docker daemon.

## vcluster.yaml Configuration

The `vcluster.yaml` file is the central configuration source. It is optional — defaults use shared nodes with SQLite backing store. Production deployments should use explicit configuration.

### Top-Level Sections

| Section | Purpose |
|---|---|
| `controlPlane` | API server, backing store, distro, HA, service exposure, CoreDNS |
| `sync` | Resource synchronization rules (toHost/fromHost) |
| `privateNodes` | Dedicated worker node configuration |
| `networking` | CIDRs, service replication, DNS resolution |
| `exportKubeConfig` | Kubeconfig generation and export settings |
| `logging` | Structured logging configuration |

### Control Plane

```yaml
controlPlane:
  distro:
    k8s:
      image:
        tag: v1.31.2

  backingStore:
    etcd:
      embedded:
        enabled: true  # Free tier — requires Platform connection

  coreDNS:
    embedded: true

  service:
    spec:
      type: ClusterIP  # or NodePort, LoadBalancer

  ingress:
    enabled: true
    host: vcluster-api.example.com

  statefulSet:
    highAvailability:
      replicas: 3
```

### Database Backing Store (via Kine Shim)

```yaml
controlPlane:
  backingStore:
    database:
      external:
        connector: postgres  # or mysql
        dataSource: "postgres://user:pass@host:5432/db"
```

### Immutable Settings

These cannot be changed after deployment — they require a full redeployment:

- High availability mode
- Backing store selection
- Private nodes vs shared nodes
- Kubernetes distribution (`distro`)
- Rootless mode

### Updating Existing Clusters

```bash
vcluster create VCLUSTER_NAME --upgrade -f vcluster.yaml
```

Reads the updated file, compares against current config, and applies only the differences. Sync settings take effect immediately; control plane changes may trigger pod restarts.

## Resource Syncing

The syncer replicates resources between virtual and host clusters. It is essential for shared-nodes deployments.

### toHost — Virtual to Host

| Resource | Default | Notes |
|---|---|---|
| Pods | Enabled | Core workload syncing |
| Secrets | Enabled | Referenced by pods |
| ConfigMaps | Enabled | Referenced by pods |
| Services | Enabled | Network access |
| Endpoints | Enabled | Service backends |
| PersistentVolumeClaims | Enabled | Storage |
| Ingresses | Disabled | Enable for external access |
| NetworkPolicies | Disabled | Enable for network isolation |
| PersistentVolumes | Disabled | Enable for direct PV management |
| ServiceAccounts | Disabled | Enable for operators/controllers |
| Namespaces | Disabled | Multi-namespace mode |

### fromHost — Host to Virtual

| Resource | Default | Notes |
|---|---|---|
| Events | Enabled | Observability |
| Nodes | Disabled | Enable to sync real nodes instead of pseudo nodes |
| StorageClasses | Disabled (`auto`) | Auto-enables with virtual scheduler |
| CSINodes | Disabled (`auto`) | Auto-enables with virtual scheduler |
| IngressClasses | Disabled | Enable when syncing ingresses |

### Name Rewriting

When syncing toHost, vCluster rewrites resource names:

```text
NAME-x-NAMESPACE-x-VCLUSTER_NAME
```

Example: pod `nginx` in namespace `default` of vCluster `my-vcluster` becomes `nginx-x-default-x-my-vcluster` on the host. Management labels are added: `vcluster.loft.sh/namespace`, `vcluster.loft.sh/managed-by`.

### Bidirectional Sync

For toHost resources, `metadata.labels` and `metadata.annotations` always sync bidirectionally. Additional bidirectional fields by resource:

| Resource | Bidirectional fields |
|---|---|
| Pods | `status.conditions` |
| Secrets | `spec.data`, `type` |
| ConfigMaps | `spec.data`, `spec.binaryData` |
| Services | `spec.type`, `spec.ports`, `spec.externalIPs`, `spec.loadBalancerIP`, `spec.sessionAffinity` |
| PersistentVolumes | `spec.capacity`, `spec.accessModes`, `spec.nodeAffinity` |

### Sync Patches

Patches transform resources during syncing using JavaScript expressions:

```yaml
sync:
  toHost:
    pods:
      patches:
        - path: metadata.annotations["custom.io/team"]
          expression: '"team-alpha"'
        - path: spec.containers[*].image
          expression: '"registry.internal/" + value'
          reverseExpression: 'value.replace("registry.internal/", "")'
```

### Multi-Namespace Mode

```yaml
sync:
  toHost:
    namespaces:
      enabled: true
      mappings:
        byName:
          "foo/*": "foo-in-virtual/*"
          "foo/my-object": "foo/my-virtual-object"
```

### Node Sync Options

```yaml
sync:
  fromHost:
    nodes:
      enabled: true
      clearImageStatus: true   # Remove image data to save resources
      syncBackChanges: false   # Do not propagate label/taint changes back to host
      selector:
        all: false             # Only sync nodes with assigned pods
        labels:
          gpu: "true"
```

## Networking

### Service Replication

```yaml
networking:
  replicateServices:
    toHost:
      - from: my-service
        to: host-service
    fromHost:
      - from: host-namespace/host-service
        to: virtual-service
```

### DNS Resolution

vCluster runs its own CoreDNS instance. By default, DNS queries resolve within the virtual cluster.

```yaml
networking:
  advanced:
    clusterDomain: cluster.local
    fallbackHostCluster: true   # DNS fallback to host services
```

### CIDR Configuration

Required when using private nodes or when auto-detection fails:

```yaml
networking:
  podCIDR: 10.64.0.0/16
  serviceCIDR: 10.128.0.0/16
```

### Kubelet Proxy

```yaml
networking:
  advanced:
    proxyKubelets:
      byHostname: true
      byIP: false
```

## CLI Reference

### Global Flags

All commands accept: `--config`, `--context`, `--debug`, `--log-output`, `-n/--namespace`, `-s/--silent`.

### Lifecycle Commands

| Command | Purpose | Key flags |
|---|---|---|
| `vcluster create NAME` | Create a virtual cluster | `-f values.yaml`, `--upgrade`, `--expose`, `--driver`, `--connect` |
| `vcluster connect NAME` | Connect to a virtual cluster | `--print`, `--service-account`, `--background-proxy` |
| `vcluster disconnect` | Disconnect from current vCluster | — |
| `vcluster list` | List virtual clusters | `--output json`, `--driver` |
| `vcluster describe NAME` | Describe a virtual cluster | `-o json/yaml`, `--config-only` |
| `vcluster pause NAME` | Pause (scale down, free resources) | `--prevent-wakeup` |
| `vcluster resume NAME` | Resume a paused vCluster | — |
| `vcluster delete NAME` | Delete a virtual cluster | `--delete-namespace`, `--keep-pvc`, `--ignore-not-found` |

**Aliases:** `list`/`ls`, `delete`/`rm`, `pause`/`sleep`, `resume`/`wakeup`.

### Driver Modes

| Driver | Description |
|---|---|
| `helm` | Default. Manages vCluster via Helm releases. |
| `platform` | Manages via vCluster Platform API. Requires platform login. |
| `docker` | Manages vCluster as Docker containers (vind). |

Switch with `vcluster use driver <helm|platform|docker>` or per-command with `--driver`.

### Platform Commands

All under `vcluster platform` (alias: `vcluster pro`):

| Command | Purpose |
|---|---|
| `platform login URL` | Authenticate to vCluster Platform |
| `platform logout` | Log out of Platform |
| `platform start` | Install Platform in a cluster |
| `platform destroy` | Remove Platform installation |
| `platform add cluster` | Register a host cluster |
| `platform add vcluster` | Register an existing vCluster |
| `platform list vclusters` | List Platform-managed vClusters |
| `platform list clusters` | List connected clusters |
| `platform list projects` | List projects |
| `platform create vcluster` | Create via Platform |
| `platform delete vcluster` | Delete via Platform |
| `platform connect vcluster` | Connect via Platform |
| `platform share vcluster` | Share with user/team |
| `platform sleep vcluster` | Put to sleep |
| `platform wakeup vcluster` | Wake from sleep |
| `platform backup management` | Backup management plane |
| `platform access-key` | Print access token |
| `platform set secret` | Set project/shared secret |
| `platform get current-user` | Show logged-in user |
| `platform reset password` | Reset user password |

### Operations Commands

| Command | Purpose |
|---|---|
| `snapshot create NAME TARGET` | Snapshot to OCI/S3/container |
| `snapshot get NAME TARGET` | Get snapshot info |
| `restore NAME TARGET` | Restore from snapshot |
| `debug collect` | Collect diagnostic info |
| `debug shell NAME` | Ephemeral debug container |
| `certs check` | Check certificate status |
| `certs rotate` | Rotate client/server certs |
| `certs rotate-ca` | Rotate CA certificate |
| `registry push` | Push image/chart to vCluster registry |
| `registry pull` | Pull image to tarball |
| `registry proxy` | Proxy registry for local Docker |
| `token create` | Create node bootstrap token |
| `token list` | List bootstrap tokens |
| `token delete` | Delete bootstrap token |
| `node delete` | Remove node from vCluster |
| `node load-image` | Load local image into node |
| `node upgrade` | Upgrade a node |

**Snapshot targets:** `oci://ghcr.io/user/repo:tag`, `s3://bucket/key`, `container:///data/snapshot.tar.gz`.

## Deployment Methods

| Method | Command / resource | Notes |
|---|---|---|
| vCluster CLI | `vcluster create NAME -f vcluster.yaml` | Recommended; handles connect automatically |
| Helm | `helm upgrade --install NAME vcluster --repo https://charts.loft.sh` | Chart: `vcluster`, repo: `https://charts.loft.sh` |
| Terraform | `helm_release` resource via Helm provider | Standard Terraform Helm pattern |
| ArgoCD | `Application` CR with chart reference | `argocd app sync NAME` |
| Flux | `HelmRepository` + `HelmRelease` | Requires `exportKubeConfig` with `insecure: true` |
| Cluster API | `clusterctl init --infrastructure vcluster:v0.2.0` | CAPI provider |

**Prerequisites:** kubectl, Helm v3.10.0+, Kubernetes v1.28+ (for Kubernetes-based). Docker only (for vind).

## Licensing

| Tier | License | Platform required | Cost |
|---|---|---|---|
| OSS | Apache 2.0 | No | Free |
| Free | Platform license | Yes | Free (no credit card) |
| Dev | Commercial | Yes | Paid |
| Prod | Commercial | Yes | Paid |
| Scale | Commercial | Yes | Paid |

### Features by Tier

| Feature | OSS | Free | Dev+ |
|---|---|---|---|
| Core virtual clusters | Yes | Yes | Yes |
| Resource syncing (built-in types) | Yes | Yes | Yes |
| k3s, k0s, vanilla k8s, EKS distros | Yes | Yes | Yes |
| Embedded etcd | — | Yes | Yes |
| Private nodes | — | Yes | Yes |
| Generic sync (custom resources) | — | Yes | Yes |
| Sync patches | — | Yes | Yes |
| Standalone mode | — | Yes | Yes |
| Hybrid scheduling | — | Yes | Yes |
| High availability | — | — | Yes |
| Auto sleep | — | — | Yes |
| External database | — | — | Yes |
| SSO / OIDC | — | — | Yes |
| Audit logging | — | — | Yes |
| FIPS compliance | — | — | Yes |
| Air-gapped mode | — | — | Add-on |

### License Validation

1. Platform contacts `admin.loft.sh` periodically to retrieve/validate license
2. Virtual clusters authenticate with Platform via access key (stored in `vcluster-platform-api-key` Secret)
3. Platform returns license status; features are enabled/disabled accordingly

**Graceful degradation:** virtual clusters never stop functioning due to license issues. On validation failure, they fall back to the OSS feature set. Workloads continue running.

### Activating the Free Tier

```bash
vcluster platform start
vcluster platform add vcluster my-vcluster
```

## Common Pitfalls

**Immutable settings require redeployment.** Changing the backing store, distribution, HA mode, or private/shared node topology after creation requires deleting and recreating the vCluster.

**`[PLATFORM]` flags are silently ignored.** Flags marked `[PLATFORM]` in CLI help only function when the platform driver is active and you are logged in. With the default helm driver, they are accepted but do nothing.

**Pod name rewriting breaks direct references.** Host-side pod names follow the `NAME-x-NAMESPACE-x-VCLUSTER_NAME` pattern. Scripts, monitoring, or alerting that reference pod names by their virtual-cluster identity will not find them on the host.

**`vcluster login` is deprecated.** Use `vcluster platform login` instead.

**Helm values list-replace applies.** Since vcluster.yaml is processed as Helm values, lists are completely replaced (not merged) when using `-f` overrides or `--set`.

**Private nodes cannot be added post-creation.** The `privateNodes.enabled` setting must be true at initial deployment. Converting an existing shared-nodes vCluster to private nodes is not supported.

**Default backing store is SQLite.** Without explicit configuration, vCluster uses SQLite (via Kine shim). Suitable for development but not production. Use embedded etcd (Free tier) or an external database (Enterprise) for production.

**Virtual scheduler auto-enables with private nodes.** When `privateNodes.enabled: true`, the virtual scheduler is automatically enabled and cannot be disabled. Resource synchronization, integrations, k3s distro, embedded CoreDNS, and sleep mode are unsupported with private nodes.
