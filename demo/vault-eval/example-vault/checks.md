# Checks: Acme Notes writer agent

Quality checks for drafts written by the (fictional) Acme Notes writer agent.
Format: see the README, "Vault checks.md".

```check
id: no-guarantee-claims
severity: critical
date: 2026-09-02
correction: Never say the product guarantees anything. Legal flagged it twice.
criterion: Does the draft avoid claiming the product guarantees an outcome?
rule:
  not-contains: guaranteed
```

```check
id: no-internal-codenames
severity: critical
date: 2026-09-02
correction: Project Walnut is an internal codename. It must not appear in customer copy.
criterion: Does the draft avoid the internal codename "Project Walnut"?
rule:
  not-contains: Project Walnut
```

```check
id: no-hedging
severity: normal
date: 2026-09-09
correction: Too much "I think" and "maybe". State it plainly.
criterion: Does the draft avoid hedging phrases such as "I think" or "maybe"?
```

```check
id: names-next-step
severity: normal
date: 2026-09-09
correction: The ending never says what the reader should do next.
criterion: Does the draft state a clear next step for the reader?
```

```check
id: intro-is-short
severity: normal
date: 2026-09-16
correction: Release notes should stay under 120 words.
criterion: Is the draft under 120 words?
rule:
  max-words: 120
```
