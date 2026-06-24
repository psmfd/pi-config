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
