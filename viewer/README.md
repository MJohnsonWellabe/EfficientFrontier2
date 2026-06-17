# viewer/ — the six-tab HTML app

- `index.html` — markup + styles; loads the `src/` engine modules + `frontier.js` + Chart.js,
  and fetches inputs from `data/` at runtime.
- `app.js` — rendering / UI layer. Computes in-browser using the shared `src/frontier.js` module
  (same math as `runner/`). DOM bindings live inside `DOMContentLoaded` via `bindAll`.

It is a viewer over the engine + `data/`, not a separate compute path. Serve from the repo root
(e.g. `python3 -m http.server`) and open `/viewer/index.html` — `fetch` needs http(s), not file://.
