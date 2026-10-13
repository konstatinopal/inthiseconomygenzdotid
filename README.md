# inthiseconomygenz.id

A local-first, privacy-respecting envelope budgeting app, built from
`Actual Budget — Product Requirements Document (Rebuild).md`. Budget data lives
in SQLite on your device, works fully offline, and can optionally sync through a
self-hosted server with end-to-end encryption.

## Quick start

```bash
npm install
npm run dev          # web app on http://localhost:3001 (local-only mode)
npm run dev:server   # optional sync server on http://localhost:5006
npm start            # build the web app and serve it from the sync server (port 5006)
npm test             # unit, sync-convergence and API tests
npm run typecheck
```

Open the app, click **Try demo** for a populated budget, or **New budget**.
## Production deployment (Docker Compose)

`docker-compose.yml` runs the app (sync server + web app) and, optionally, the HTTP API.

```bash
cp .env.example .env        # set PUBLIC_URL and ADMIN_PASSWORD (and Google, API values if used)
docker compose up -d --build                # the app on 127.0.0.1:5006
docker compose --profile api up -d --build  # also the HTTP API on 127.0.0.1:5007
docker compose logs -f app
```

- **Ports** are published on `127.0.0.1` by default, for a reverse proxy or load balancer on the same host that terminates HTTPS (nginx, Traefik, a cloud LB…). Point it at `127.0.0.1:5006`. Set `APP_BIND=0.0.0.0` to expose the port to the network directly, but that is plain HTTP: passwords would travel unencrypted.
- **Behind a proxy**, set `TRUSTED_PROXIES` to its address as the container sees it (a proxy on the host connects from the Docker gateway, `172.30.0.1`), so login rate limits see real client IPs. Leave it empty when clients connect directly; forwarded-for headers are then ignored.
- **`PUBLIC_URL`** is the address users open (e.g. `https://budget.example.com`). For Google sign-in, add `PUBLIC_URL/openid/callback` as the OAuth redirect URI.
- **Data** lives in the `app-data` volume (budgets, users, sessions). Back it up, e.g. `docker run --rm -v inthiseconomygenz_app-data:/data -v "$PWD":/backup alpine tar czf /backup/app-data.tgz -C /data .`
- **Upgrading**: `git pull && docker compose up -d --build`. Containers run as a non-root user and have health checks.

## Multi-user: accounts, login page and Google sign-in

By default the sync server uses one shared password. Multi-user mode gives each person their own account, signing in with a username and password, with Google, or both.

```bash
ENVELOPE_LOGIN_METHOD=multiuser \
ENVELOPE_PUBLIC_URL=https://budget.example.com \
ENVELOPE_ADMIN_USER=admin \
ENVELOPE_ADMIN_PASSWORD='choose-a-strong-one' \
npm run start -w @envelope/sync-server
```

- **Default admin.** On first start the server creates the admin account `ENVELOPE_ADMIN_USER` (default `admin`, or `ENVELOPE_ADMIN_EMAIL` when set). Without `ENVELOPE_ADMIN_PASSWORD` a random temporary password is printed in the server log, and the admin must change it at first sign-in.
- **Login page.** Opening the app shows `/login` whenever a server is configured and nobody is signed in (the address is detected automatically when the server hosts the app). People can also continue without signing in and use the app on this device only.
- **Adding people.** Admins add users under **User directory** (account menu), by email or username, optionally with a temporary password the user replaces at first sign-in. Admins can reset or remove passwords there.
- **Security.** Passwords are bcrypt-hashed, need 8+ characters, and 5 wrong attempts lock that account from that address for 5 minutes. Changing a password signs out the user's other sessions.

**Adding Google sign-in.** In Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID** of type *Web application* with the redirect URI `https://<your server>/openid/callback`, then also set:

```bash
ENVELOPE_OPENID_CLIENT_ID=<client id>
ENVELOPE_OPENID_CLIENT_SECRET=<client secret>
ENVELOPE_ADMIN_EMAIL=you@gmail.com   # lets the default admin use Google too
```

The login page then shows **Sign in with Google**. Only people in the user directory can sign in (match is by their Google email); `ENVELOPE_ALLOWED_DOMAINS=example.com` admits a whole domain. When the web app runs on another origin (e.g. `npm run dev` on :3001), add `ENVELOPE_ALLOWED_ORIGINS=http://localhost:3001`. `ENVELOPE_OPENID_ISSUER` points at any other OpenID Connect provider. `ENVELOPE_LOGIN_METHOD=openid` still works as an alias for `multiuser`.

Owners and admins can share, rename, reset sync, change the encryption key and delete a budget; collaborators can open and sync it. Switching an existing password server to multi-user mode gives its files to the default admin. The spec is in the PRD doc “Envelope — Multi-User & Google Sign-In”.

## Scripting: the Node API

There is no REST endpoint for budget data: the server only relays (possibly encrypted) changes. Scripts use `@envelope/api`, which downloads a budget, changes it locally with the same engine as the app, and syncs back. See `packages/api/examples/add-transactions.ts`:

```bash
ENVELOPE_URL=http://localhost:5006 ENVELOPE_USER=admin ENVELOPE_PASSWORD=... ENVELOPE_BUDGET="Demo Budget" \
  npx tsx packages/api/examples/add-transactions.ts
```

Amounts are integer cents (negative = payment). `addTransactions` runs rules and accepts `payee_name` and `subtransactions`; `importTransactions` dedupes by `imported_id` and amount/date, so re-running a bank import adds nothing twice. Every engine handler is also reachable as `api.send(name, args)`.

## HTTP API (curl)

For tools that can only make web requests, `packages/http-api` runs a small service in front of the sync server. It signs in as one server account, keeps local copies of that account's budgets, syncs before reads and after writes, and answers JSON.

```bash
export ENVELOPE_API_KEYS=$(openssl rand -hex 32)   # callers send this as a Bearer token
ENVELOPE_URL=http://localhost:5006 ENVELOPE_USER=admin ENVELOPE_PASSWORD=... npm run start:api   # listens on 127.0.0.1:5007
```

```bash
KEY=...; U=http://127.0.0.1:5007
curl -H "Authorization: Bearer $KEY" $U/v1/budgets
curl -X POST "$U/v1/budgets/Demo%20Budget/transactions" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"account":"Checking","date":"2026-10-13","amount":"-45.20","payee":"Corner Bakery","category":"Groceries","notes":"lunch"}'
```

| Method and path | What it does |
| --- | --- |
| `GET /v1/budgets` | Budgets this account can access |
| `GET /v1/budgets/:budget/accounts` · `/categories` · `/payees` | Names, ids and balances |
| `GET /v1/budgets/:budget/transactions?account=&category=&since=&until=&search=&limit=` | Transactions, newest first |
| `POST /v1/budgets/:budget/transactions` | Add one transaction, or `{"account": …, "transactions": [...]}`; add `"dedupe": true` for bank data |
| `GET` · `PATCH` · `DELETE /v1/budgets/:budget/transactions/:id` | Read, edit or delete one |
| `GET /v1/budgets/:budget/months/2026-10` | To Budget and each category's budgeted, spent and balance |

- `:budget`, `account`, `category` and `payee` take a name or an id; an unknown payee name creates the payee.
- `amount`: an integer is cents (`-4520`), a string is a decimal amount (`"-45.20"`). Negative is a payment.
- Splits: `"subtransactions": [{"amount": -6000, "category": "Groceries"}, …]` must add up to `amount`.
- `"dedupe": true` runs the import pipeline: rules apply, and rows matching an existing transaction (same `imported_id`, or same amount within 7 days) are merged instead of added, so re-sending is safe.
- Responses include `"synced": true|false`; a failed upload is kept locally and retried on the next request.
- Security: keys must be 24+ characters. The service holds decrypted budget data, so it listens on 127.0.0.1 by default (`ENVELOPE_API_HOST` to change); put it behind HTTPS before exposing it. End-to-end encrypted budgets need `ENVELOPE_KEY_PASSWORD`.

## Layout

| Package | Role |
| --- | --- |
| `packages/crdt` | Hybrid Logical Clock timestamps (46-char sortable), base-3 Merkle trie, message types |
| `packages/core` | The engine: SQLite (sql.js) schema + migrations, CRDT write path with undo/redo, AQL query builder, accounts, transactions (splits, transfers, merge), envelope + tracking budgets, templates & cleanup, rules, schedules, importers (CSV/TSV/OFX/QFX/QIF/CAMT.053) with one dedupe pipeline, reports, sync client, AES-256-GCM encryption, ~130 RPC handlers |
| `packages/web` | React UI; the engine runs in a Web Worker and is called only through `send(name, args)` |
| `packages/sync-server` | Express server: password/header auth, token sessions, message relay with Merkle diffing, file snapshots, encryption-key storage, CORS proxy, health/info/metrics; serves the built web app |
| `packages/api` | Node library over the same engine with filesystem storage |
| `packages/http-api` | Optional JSON HTTP API (curl) on top of the Node library, with API keys |

## Architecture notes

- **Every write is a CRDT message** `(timestamp, dataset, row, column, value)`, applied last-writer-wins per cell, logged in `messages_crdt` and added to the Merkle trie. Undo/redo replays old/new cell values as new messages, so it syncs too.
- **Money is integer cents** everywhere; formatting happens only at display time.
- **Derived budget values** are computed in one pass from grouped SQL aggregates and cached until a relevant table is written.
- **Sync**: the client sends messages since its last sync, applies what the server returns, and re-syncs from the earliest differing minute until the tries match. Uploading a file starts a new sync group; other devices re-download (also how "reset sync" and key changes work).
- **E2E encryption**: PBKDF2 (SHA-512, 200k iterations) → AES-256-GCM; the server stores only ciphertext and a salt + test value to verify passwords.

## Scope of this first build

Implemented: PRD Phase 1–3 core — budget files (create, demo, open, rename, duplicate, delete, export/import), accounts (on/off budget, close/reopen with balance transfer, reorder, notes, reconciliation), the keyboard-first register (inline editing, autocomplete, splits, transfers, cleared/reconciled locking, bulk edit, merge, make-transfer, search, filter builder, saved filters, tags, upcoming schedules, CSV export, column toggles, virtualised rows), envelope and tracking budgets (move money, cover overspending, rollover, holds, copy/zero/averages, templates with priorities, goals and goal indicators, cleanup), categories and groups (drag reorder, hide, delete with history merge), payees (merge, favorites, unused, learning toggle), the rule engine (stages, specificity, all ops, preview, apply, auto-learned category rules), schedules (patterns, weekend handling, end conditions, auto-post, match, skip, post, discover, convert), the import pipeline, six reports (net worth, cash flow, spending analysis, custom report with drilldown, calendar, age of money), settings (theme, number/date/currency format, budget type), privacy filter, command bar, shortcuts, undo/redo, responsive mobile layout, the sync server, multi-device sync and E2E encryption.

Not yet built (later PRD phases): bank-sync providers (GoCardless, SimpleFIN, …), OpenID and multi-user access control, YNAB4/nYNAB and Actual-zip importers, configurable drag-and-drop dashboards (reports are fixed cards), experimental reports (budget analysis, forecast, Sankey, formula, Monte Carlo), rule split actions and templated actions, account groups, payee locations, Electron and Capacitor shells, the CLI, i18n, and the plugin service. The browser build persists the SQLite image to IndexedDB on each change rather than via absurd-sql, which is fine for typical budgets but should be revisited for the 50k-transaction performance target.
