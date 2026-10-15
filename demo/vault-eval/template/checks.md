# Checks

One fenced `check` block per check. Add new ones by hand, or from reviewer
corrections with `mem vault-check add`.

Fields:

- `id`: stable slug, unique in this file.
- `severity`: `critical` (a failure blocks the draft) or `normal`.
- `date`: ISO date the check was added.
- `correction`: the reviewer's original note, verbatim.
- `criterion`: a yes/no question where "yes" means the draft is fine.
- `rule` (optional): a code rule instead of a judge call. Exactly one of
  `contains`, `not-contains`, `regex`, `max-words`, `min-words`.

```check
id: example-check
severity: normal
date: 2026-01-01
correction: Replace this with the reviewer's original note.
criterion: Does the draft do the thing the reviewer asked for?
```
