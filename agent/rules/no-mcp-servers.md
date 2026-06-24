---
description: Prohibit MCP server references and network-sourced system-context injection
---

# No MCP Servers

This repo prohibits MCP server usage in all content it produces or distributes.

When creating or editing agent wrappers, skill files, or configuration:

- **Never add `mcp-servers`** to any frontmatter field in agent wrappers or skill files.
- **Never include `.claude/settings.json`** in any committed content — platform configuration belongs in user-level settings outside the repo.
- **Never reference MCP server packages** (npm, PyPI, or otherwise) in skill content or instructions.
- All tool access must be controlled through explicit **`tools` allowlists** in agent wrapper frontmatter (see [`agent/agents/`](../agents/) for examples) or through pi extensions vendored under [`agent/extensions/`](../extensions/).
- If a user requests MCP server integration, explain this policy and suggest the pi-native extension approach instead.

This policy exists because MCP servers loaded at runtime are the primary attack vector for OWASP ASI04 (Supply Chain Vulnerabilities) and have surfaced in multiple LLM-harness CVEs (e.g. CVE-2025-59536, CVE-2026-21852).

## Network-sourced context injection

The policy extends to **any runtime mechanism that injects external network content into the harness system context**, not just MCP servers as a protocol. The threat model is identical regardless of protocol: a runtime-loaded source whose content is treated as harness instructions creates a supply-chain injection vector with session-scope blast radius.

Specifically prohibited:

- **Hooks** (`UserPromptSubmit`, `PostToolUse`, or any other event) that fetch content from a remote URL and emit it as `systemMessage` or any other channel that the harness treats as system-role context.
- **Scripts** that read external HTTP responses and inject them into agent context without prior signing, allowlisting, or explicit user review.
- **Any mechanism** where a remote endpoint can dictate harness-level instructions for the session.

This is consistent with the substrate decision in [`adrs/0001-subagent-orchestration-substrate.md`](../../adrs/0001-subagent-orchestration-substrate.md): subagents run in isolated subprocesses with restricted, statically-declared tool sets — there is no runtime mechanism by which a remote endpoint can grant additional capability.

Defense-in-depth alternatives that do **not** contradict this policy:

- Pi extensions vendored into [`agent/extensions/`](../extensions/) with source-pi version pinned by snapshot (the substrate ADR mechanism).
- Hooks that emit static content from local files only — no `curl`, no `fetch`.
- Hooks that emit content the user explicitly approved out-of-band (e.g. signed snapshots verified against an allowlist of public keys).
- Tool-call style retrieval where the agent makes the request as a tool invocation (visible in the activity stream) and the result enters context as untrusted tool output, not system role. The vendored `subagent` extension and any future `expertise-api`-style extension follow this pattern.

## When this rule applies

- All content authored in this repo: agent wrappers, skills, prompt templates, extensions, ADRs, rules.
- All advisory output from agents in this repo regardless of target project: do not suggest MCP server adoption to downstream repos either.

## When this rule does not apply

- Reading or analysing third-party MCP server code for the purpose of evaluating risk — analysis is not adoption.
- Documenting that a particular CVE exists in the MCP ecosystem — informational content about the threat model is in scope.
