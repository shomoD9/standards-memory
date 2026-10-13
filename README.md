# standards-memory

Git-backed shared fact store for agent teams.

## Local web view

Build with `npm run build`, then run `mem web` (or `node dist/cli.js web`).
Open `http://127.0.0.1:4747`. Use `mem web --port 8080` to choose another port.
The view uses the same store as the CLI (`MEM_DIR`, default `./.mem`).

Search and browse facts, follow links and backlinks, inspect each fact's history,
view the graph, and undo recent changes. Undo creates a Git revert commit in the
fact store; conflicts appear as an error in the view.

The local JSON API provides:

- `GET /api/facts` — facts; optional `?q=...` keyword search.
- `GET /api/facts/:id` — fact with `backlinks`; 404 if absent.
- `GET /api/history/:id` — newest-first history, including deleted facts.
- `GET /api/graph` — nodes, directed edges, and backlinks.
- `GET /api/log` — up to 50 recent commits, newest first.
- `POST /api/undo/:change` — revert a commit, returning `{ "change": "..." }`.

API errors return `{ "error": "..." }` with an appropriate HTTP status.
The server listens on `127.0.0.1` only.
