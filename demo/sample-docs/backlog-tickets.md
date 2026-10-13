> Sample document for the standards-memory demo. Fictional content.

# Acme Notes: sample backlog tickets

These are made-up tickets used as demo data.

## ACME-101: Live preview flickers on long notes

Typing in a note longer than 2,000 lines makes the preview pane flicker. Expected: preview updates without flicker. Acceptance: a test renders a 5,000-line note and asserts no more than one repaint per keystroke. Owner: frontend. Next step: reproduce with the attached note.

## ACME-102: Add author filter to search

Search results should be filterable by author. Acceptance criteria: the API accepts an `author` parameter, and unit tests cover empty, single, and multiple authors. Owner: backend. Decision needed: whether the filter matches display names or user ids.

## ACME-103: Decisions page layout

Design the decisions page: one row per tagged line, grouped by note, newest first. Owner: design. Next action: share a mockup for review by Friday.
