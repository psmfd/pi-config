# Content Style

## Technical Writing Principles

- Clarity over cleverness — say exactly what you mean
- Precision over brevity — do not sacrifice accuracy for conciseness
- Brevity over verbosity — but only after clarity and precision are met
- Active voice for instructions: "Run the script" not "The script should be run"
- Imperative mood for procedures: "Configure the endpoint" not "You should configure the endpoint"
- Present tense for descriptions: "The function returns" not "The function will return"

## Terminology Consistency

- Define terms on first use in a document
- Maintain a glossary for project-specific terminology
- Use consistent naming: pick one term and use it everywhere (not "endpoint" in one place and "route" in another)
- Avoid jargon when a common term exists — unless writing for a specialist audience that expects it

## Code Examples in Documentation

- Every example must be runnable as-is (no pseudocode in tutorials)
- Minimal — include only what demonstrates the concept
- Annotated — explain non-obvious lines with inline comments or surrounding prose
- Show expected output alongside input
- Use realistic but safe values (not `password123` or `example.com` for real config)

## Common Anti-Patterns

| Anti-pattern | Problem | Fix |
|---|---|---|
| Wall of text | Readers skip it | Break into headed sections, use lists |
| Buried lede | Key information hidden in paragraph 3 | Lead with the answer or action |
| Ambiguous pronouns | "It" and "this" without clear referent | Name the subject explicitly |
| Outdated screenshots | Visual docs rot fastest | Prefer text descriptions; screenshot only when essential |
| Assumed context | "As discussed" without link | Always link to the source |
| Passive instructions | "The config file should be edited" | "Edit the config file" |

## Claudish / LLM-Prose Anti-Patterns

LLM-drafted documentation pads, hedges, and abstracts in recurring ways beyond the general anti-patterns above — "Claudish": prose that is accurate but hard to read. When creating or reviewing documentation, detect these patterns and rewrite them into plain English.

| Anti-pattern | Problem | Fix |
|---|---|---|
| Hedging stacks | "It's worth noting that", "generally speaking", "in most cases" chained onto one claim — the reader cannot tell rule from suggestion | State the claim plainly; keep a qualifier only when it names a real exception |
| Filler transitions | "Additionally", "Furthermore", "It is important to note that" — length without information | Delete; let sentence order carry the flow |
| Jargon stacking | "Leverage the orchestration layer to operationalize the workflow" — abstraction hides the concrete action | One concrete verb: "use X to do Y" |
| Marketing adjectives | "Robust", "seamless", "powerful", "comprehensive" — unverifiable praise, no content | Delete, or state the measurable property ("retries twice, then fails closed") |
| Nominalizations | "Perform validation of", "achieve optimization of" — the verb is buried inside a noun | Use the verb: "validate", "optimize" |
| Over-qualification | "Where applicable, and depending on context, it may be preferable to…" — the claim drowns in caveats | One claim per sentence; a caveat gets its own sentence only if actionable |
| Symmetry padding | "Not only X but also Y", "both A and B alike" — rhetorical balance without added meaning | Say X and Y plainly |
| Structure padding | Headers and bullet lists wrapping one sentence each — looks thorough, but each piece is thin | Merge into prose; reserve structure for genuinely parallel items |
| Summary restating | "In summary, as described above…" — repeats what the reader just read | Delete, or add genuinely new synthesis |

### Rewrite Contract

A plain-English rewrite changes style density only. It must preserve:

- Every fact, name, number, link, and file path
- Code blocks and YAML frontmatter — reproduced exactly, never rewritten
- Document structure — headings, lists, and tables stay where they are
- Claim strength and modality — must/should/may, and any stated exception or condition. A qualifier that encodes a real rule condition is content, not style; when unsure whether a hedge is style or substance, keep it and flag it as a finding instead of rewriting it

### Calibration

Same specialist-audience exception as Terminology Consistency above: the pass targets *style* density, not domain vocabulary. Domain terminology a specialist audience expects is not Claudish — "idempotent", "squash merge", and "JSON Patch" stay; "leverage synergies across the toolchain" goes.
