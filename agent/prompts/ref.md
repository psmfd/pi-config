---
name: ref
description: Rewrite your previous response using the communication contract's reference codes.
---

Rewrite your previous response — your most recent assistant turn — using
reference codes per `agent/rules/communication-contract.md`: stable
`F#`/`D#`/`O#`/`R#`/`Q#`/`A#` codes for findings, decisions, options,
risks, questions, and actions, kept stable for the rest of the
conversation. If the previous response has fewer than three codable items,
say so instead of minting codes. Review output governed by
`structured-review-format.md` keeps its table and verdict unchanged.
