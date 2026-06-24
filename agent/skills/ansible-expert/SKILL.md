---
name: ansible-expert
description: 'Ansible reference for the ansible-expert subagent — playbooks, variable precedence, collections, Jinja2, vault, inventory, roles, CI integration.'
disable-model-invocation: true
---

# Ansible Expert

Read-only reference for Ansible guidance — variable precedence, collection architecture, privilege escalation patterns, Jinja2 pitfalls, handler semantics, and CI/CD integration.

## Variable Precedence

Ansible evaluates variables in a 22-level precedence hierarchy. Listed from lowest to highest:

| Level | Source | Common trap |
|---|---|---|
| 1 | command line values (e.g., `-u user`) | — |
| 2 | role defaults (`roles/x/defaults/main.yml`) | Often confused with role vars |
| 3 | inventory file or script group vars | — |
| 4 | inventory `group_vars/all` | Overridden by specific groups |
| 5 | playbook `group_vars/all` | — |
| 6 | inventory `group_vars/*` | — |
| 7 | playbook `group_vars/*` | — |
| 8 | inventory file or script host vars | — |
| 9 | inventory `host_vars/*` | — |
| 10 | playbook `host_vars/*` | — |
| 11 | host facts / `set_fact` cache | Persists across plays if caching enabled |
| 12 | play vars (`vars:` in play) | — |
| 13 | play `vars_prompt` | — |
| 14 | play `vars_files` | — |
| 15 | role vars (`roles/x/vars/main.yml`) | Higher than most inventory vars |
| 16 | block vars | Scoped to block only |
| 17 | task vars (in `vars:` on a task) | — |
| 18 | `include_vars` | — |
| 19 | `set_fact` / registered vars | Wins over almost everything |
| 20 | role params (when using `include_role`/`import_role`) | — |
| 21 | `include` params | — |
| 22 | extra vars (`-e` / `--extra-vars`) | Always wins |

### Key Traps

- `roles/x/defaults/` (level 2) is for overridable defaults. `roles/x/vars/` (level 15) is for internal role constants — it overrides most inventory variables.
- `set_fact` (level 19) persists for the host for the rest of the play. It defeats role vars, include_vars, and everything except extra vars.
- `group_vars/all` (levels 4-5) is lower priority than specific group vars (levels 6-7).

## Collection Architecture

### The 2.9 to 2.10 Split

| Package | Contents | Use when |
|---|---|---|
| `ansible-core` | Runtime engine, `ansible.builtin.*` modules only | CI/CD, minimal installs |
| `ansible` | Meta-package: `ansible-core` + curated community collections | Full workstation installs |

### FQCN Requirements

Post-2.10, Fully Qualified Collection Names are required:

| Pre-2.10 (deprecated) | Post-2.10 (correct) |
|---|---|
| `apt:` | `ansible.builtin.apt:` |
| `docker_container:` | `community.docker.docker_container:` |
| `uri:` | `ansible.builtin.uri:` |
| `template:` | `ansible.builtin.template:` |

### Collections Installation

```yaml
# collections/requirements.yml
collections:
  - name: community.docker
    version: ">=3.0.0,<4.0.0"
  - name: ansible.posix
```

```bash
ansible-galaxy collection install -r collections/requirements.yml
```

**Trap:** `ansible-core` alone has very few modules. If a playbook uses `community.*` or `ansible.posix.*` modules, the collection must be explicitly installed. The `ansible` meta-package masks this by bundling collections.

## Privilege Escalation

### `become` Interaction Matrix

| Setting | Effect | Trap |
|---|---|---|
| `become: true` | Escalate to `become_user` (default: root) | Applies to all tasks in scope |
| `become_method: sudo` | Use sudo (default) | Requires NOPASSWD or `become_password` |
| `become_method: su` | Use su | Requires target user password, not current user |
| `become_user: postgres` | Escalate to specific user | Must go through root first with sudo |
| `ansible_pipelining: true` | Avoids temp file on remote | Breaks if `requiretty` is set in sudoers |

### Pipelining and `requiretty`

When `pipelining: true` is set, Ansible pipes module code via stdin instead of copying temp files. `sudo` with `requiretty` in `/etc/sudoers` rejects stdin-based execution because there is no TTY. Fix: `Defaults !requiretty` in sudoers or disable pipelining.

### Scoping

`become: true` at the play level applies to ALL tasks. Set it at the task or block level to limit scope.

## Jinja2 Type Coercion

### Boolean Coercion

YAML 1.1 (Ansible's parser) treats these as booleans: `true`, `false`, `yes`, `no`, `on`, `off`, `y`, `n`, `True`, `False`, `YES`, `NO`.

| Expression | Result | Why |
|---|---|---|
| `some_var: yes` | Boolean `True` | YAML 1.1 boolean |
| `some_var: "yes"` | String `"yes"` | Quoted — always string |
| `when: my_var == true` | Compares to Python `True` | — |
| `when: my_var == "true"` | Compares to string `"true"` | Different from above |
| `when: my_var \| bool` | Coerces then tests | Safest for mixed types |

### Integer Coercion

| Expression | Result | Why |
|---|---|---|
| `port: 0` | Integer `0` | YAML parses as int |
| `when: port` | `False` | `0` is falsy in Jinja2 |
| `when: port is defined` | Correct test | Tests existence, not truthiness |

### The `| bool` Filter

Converts strings to booleans: `"yes"`, `"true"`, `"1"` become `True`; `"no"`, `"false"`, `"0"` become `False`. Use when a variable may arrive as either type.

## Handler Semantics

### Execution Rules

- Handlers run at the end of each play, not after each task
- A handler runs at most once per play, regardless of notification count
- `notify` matches by handler name (or `listen` topic) — name must be exact
- `changed_when: false` suppresses notification even if module reports changed
- `failed_when` does not prevent notification — a task can both fail and notify

### `listen` vs `notify`

`listen` allows multiple tasks to trigger the same handler via a topic name without knowing the handler's exact name. Multiple handlers can listen to the same topic.

### Flush Handlers

`meta: flush_handlers` forces handler execution mid-play. Handlers flushed this way do not run again at play end even if re-notified.

### Handlers in Roles

Handlers defined in `roles/x/handlers/main.yml` are globally scoped to the play — they can be notified by tasks outside the role. Name collisions across roles cause silent misbehavior.

## Inventory and Roles

### Role Directory Structure

```text
roles/myrole/
  defaults/main.yml    # Level 2 — overridable defaults
  vars/main.yml        # Level 15 — internal constants
  tasks/main.yml       # Task list
  handlers/main.yml    # Handlers
  templates/           # Jinja2 templates
  files/               # Static files
  meta/main.yml        # Dependencies, galaxy metadata
```

### `include_role` vs `import_role`

| Aspect | `import_role` (static) | `include_role` (dynamic) |
|---|---|---|
| When processed | At parse time | At runtime |
| `when` condition | Applied to every task in role | Applied once to the include |
| Tags | Inherited by all tasks | Only the include is tagged |
| Handlers | Available globally | Available from point of inclusion |
| Loops | Cannot loop | Can loop with `loop:` |

## Vault and Secrets

### Encryption Patterns

| Operation | Command | Use when |
|---|---|---|
| Encrypt whole file | `ansible-vault encrypt vars/secrets.yml` | All values in file are sensitive |
| Encrypt single string | `ansible-vault encrypt_string 'value' --name 'var'` | Mixed sensitive/non-sensitive in one file |
| Decrypt | `ansible-vault decrypt vars/secrets.yml` | Editing encrypted files |
| Edit in place | `ansible-vault edit vars/secrets.yml` | Quick edits without decrypt/re-encrypt |

### Multi-Password Vault IDs

```bash
# Encrypt with a vault ID
ansible-vault encrypt --vault-id prod@prompt vars/prod.yml

# Run with multiple vault passwords
ansible-playbook site.yml \
  --vault-id dev@~/.vault_dev \
  --vault-id prod@prompt
```

**Trap:** `ansible-vault encrypt` encrypts the entire file. `ansible-vault encrypt_string` encrypts a single value. Mixing encrypted and unencrypted variables in the same file requires `encrypt_string`.

## GitHub Actions Integration

### Key Constraints

- GitHub-hosted runners do not have systemd — `ansible.builtin.systemd` fails with `--connection=local`
- `ansible-core` must be installed explicitly (`pip install ansible-core`)
- Collections must be installed before running playbooks

### CI Callback Configuration

```ini
# ansible.cfg for CI
[defaults]
stdout_callback = ansible.posix.json
callbacks_enabled = ansible.posix.json
```

**Trap:** `callbacks_enabled` is for non-stdout callbacks. Setting `callbacks_enabled = json` does NOT change stdout output — you must also set `stdout_callback`.

## Callback Plugins

### Common Callbacks

| Plugin | Use |
|---|---|
| `ansible.builtin.default` | Human-readable, colored output |
| `ansible.posix.json` | Machine-parseable JSON (CI/CD) |
| `ansible.builtin.yaml` | YAML-formatted output |
| `ansible.builtin.minimal` | Minimal output (scripts) |
| `community.general.log_plays` | File-based logging |

### Configuration Precedence

1. `ANSIBLE_STDOUT_CALLBACK` environment variable (highest)
2. `stdout_callback` in `ansible.cfg`
3. Default (`ansible.builtin.default`)
