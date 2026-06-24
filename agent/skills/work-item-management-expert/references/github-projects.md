# GitHub Projects v2

Projects v2 is the closest native substitute for a structured backlog. Common custom fields: Status (Todo / In Progress / Done), Priority (mirroring `p:` labels), Iteration, Estimate, Area.

```bash
# Add an issue to a project (project-number is per-org)
gh project item-add <project-number> --owner <owner> --url <issue-url>

# Discover field IDs for editing
gh project field-list <project-number> --owner <owner> --format json

# Update a single-select field on an item
gh project item-edit \
  --project-id <project-node-id> \
  --id <item-node-id> \
  --field-id <field-node-id> \
  --single-select-option-id <option-id>
```

`gh project item-edit` requires node IDs (not human names). Always run `field-list` and `item-list` first to resolve them.
