# Mermaid Diagrams

## Diagram Type Selection

| Type | Use when | Syntax keyword |
|---|---|---|
| Flowchart | Process flows, decision trees, system interactions | `flowchart` or `graph` |
| Sequence | Request/response flows, API interactions, temporal ordering | `sequenceDiagram` |
| Class | Object relationships, inheritance, data models | `classDiagram` |
| State | Lifecycle states, status transitions, FSMs | `stateDiagram-v2` |
| Entity-Relationship | Database schemas, data model relationships | `erDiagram` |
| Gantt | Project timelines, phase planning | `gantt` |
| Pie | Proportional breakdowns (use sparingly) | `pie` |
| Journey | User experience flows, multi-actor processes | `journey` |
| Mindmap | Brainstorming, topic hierarchies | `mindmap` |
| Timeline | Historical events, version history | `timeline` |
| Quadrant | Priority matrices, comparison grids | `quadrantChart` |
| Sankey | Flow volumes, resource allocation | `sankey-beta` |
| Block | System architecture, component layouts | `block-beta` |
| Architecture | Cloud/infra topology with icons | `architecture-beta` |

## Syntax Best Practices

- Keep diagrams under 20 nodes — split complex diagrams into focused views
- Use meaningful node IDs: `authService` not `A` or `node1`
- Label edges with the action or data: `-->|"POST /login"|` not `-->`
- Use subgraphs to group related components
- Set direction explicitly: `flowchart LR` for left-to-right, `flowchart TD` for top-down
- Quote node labels containing special characters: `A["Node (with parens)"]`

## Readability

- Flowcharts: left-to-right (`LR`) for processes, top-down (`TD`) for hierarchies
- Sequence diagrams: limit to 5-7 participants; split into multiple diagrams for complex interactions
- Use `Note` blocks in sequence diagrams for context that does not fit in messages
- Color and styling should aid comprehension, not decorate — use `classDef` sparingly
- Avoid crossing edges where possible — reorder nodes to minimize crossings

## Theming and Styling

```text
%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#4a86c8'}}}%%
```

- Use `%%{init:}%%` directives for theme control
- Available themes: `default`, `neutral`, `dark`, `forest`, `base`
- `base` theme with `themeVariables` gives the most control
- `classDef` for per-node styling: `classDef critical fill:#f96,stroke:#333`
- Click handlers (`click nodeId href "url"`) add interactivity in supported renderers

## Rendering Contexts

| Context | Mermaid support | Notes |
|---|---|---|
| GitHub Markdown | Full (latest) | Renders in issues, PRs, README, wiki |
| GitLab Markdown | Full | Renders in issues, MRs, wiki |
| VS Code preview | Via extension | Markdown Preview Mermaid Support extension |
| Copilot chat (CLI/VS Code) | Not rendered | Mermaid blocks appear as raw fenced code; describe diagram intent in prose instead |
| Static site generators | Plugin-dependent | Hugo, Jekyll, Docusaurus all have plugins |
| Confluence | Via macro/plugin | Mermaid Chart plugin or HTML macro |

## Mermaid in Azure DevOps

### Supported Scope

Azure DevOps wiki renders Mermaid diagrams in wiki pages and markdown files. Support is available in:

- Azure DevOps Wiki (project wiki and code wiki)
- Pull request descriptions and comments (limited)
- Work item descriptions (limited — rendering depends on the rich text editor version)

### Version Lag

ADO bundles a specific Mermaid version that typically trails the latest release by 6-12 months. Features available in the latest Mermaid.js release may not render in ADO. Before using newer diagram types or syntax:

- Check the ADO release notes for Mermaid version updates
- Test in an ADO wiki page before committing to a diagram type
- `mindmap`, `timeline`, `quadrantChart`, `sankey-beta`, `block-beta`, and `architecture-beta` may not be available depending on the bundled version

### Known Limitations

| Limitation | Workaround |
|---|---|
| Newer diagram types may not render | Stick to flowchart, sequence, class, state, ER, Gantt, pie |
| `%%{init:}%%` directives may be partially supported | Test theme directives; fall back to default theme |
| Click handlers do not work | Use surrounding markdown links instead |
| Font rendering differs from GitHub | Avoid relying on precise text sizing for layout |
| Large diagrams may fail to render | Keep under 15-20 nodes; split complex diagrams |
| Inline HTML in node labels not supported | Use plain text or Mermaid-native formatting |

### ADO Wiki Markdown Quirks

- Mermaid blocks use standard triple-backtick fencing with `mermaid` language tag
- Indented Mermaid blocks (e.g., inside list items) may fail to render — keep Mermaid blocks at the top level or use minimal indentation
- ADO wiki uses a subset of CommonMark — some advanced markdown features around Mermaid blocks may not parse correctly
- Page-level TOC (`[[_TOC_]]`) and Mermaid coexist without issues
- Mermaid blocks in wiki templates render correctly

### ADO Integration Patterns

- **Pipeline visualization:** use Gantt diagrams to document pipeline stages and dependencies alongside the YAML definition
- **Architecture diagrams:** flowcharts or block diagrams in the project wiki for infrastructure topology
- **Work item flow:** state diagrams to document board column transitions and rules
- **Sprint planning:** Gantt charts for iteration timelines (but prefer ADO's built-in sprint tools for active tracking)
- **Deployment topology:** flowchart with subgraphs for environments (dev, staging, prod) showing service dependencies
