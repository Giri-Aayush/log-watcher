# design/

Source of truth for the console UI, exported from the Claude Design project
"Zebra monitoring dashboard design" (`d3b5fef9-e718-430b-b1e6-5033c55356ed`).

- `zero-tokens.css` — the design tokens. `public/` pages should use these
  variables rather than restating colors.
- `Zero Overview.dc.html` — the Overview / fleet screen. `.dc.html` files are
  React-templated mockups rendered by `support.js`: `{{ name }}` is a value
  from `renderVals()`, `<sc-for>` / `<sc-if>` are loops and conditionals,
  `style-hover` is a hover style, `onClick="{{ fn }}"` a handler. The
  `<script data-dc-script>` block documents the intended behaviour (window
  selector, ticking ages, the 10-minute unacknowledged threshold, stacked
  bars). The implementation in `public/` is plain HTML/CSS/JS reading the
  collector's `/api/*` endpoints; the mock's sample data is illustrative.
- `support.js` — the mock runtime, kept only so the mock can be opened as-is.

- `Zero Incident.dc.html` — the incident detail screen (lifecycle strip, actions,
  RPC latency around the page, log excerpt, triage draft, audit trail).

- `Zero Node.dc.html` — node detail (four series charts, log-lag sparkline,
  incident history, sidecar facts, thresholds in effect).
- `Zero Sidecar.dc.html` — the sidecar's own page on the customer's box (the
  operator view): tiles, active alerts with `next:`, last block, the parsed
  event feed, the live log with a level filter.

`Zero Components.dc.html` is the design-system sheet; it is not a product
screen and is not imported.
