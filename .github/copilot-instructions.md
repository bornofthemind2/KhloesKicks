# Guidance for AI coding agents (sneaker-auction)

This file contains concise, actionable information an AI coding agent needs to be productive in this repository.

1) Big picture
- Node.js Express app (ESM) in `server.js` serving EJS views (`views/`) and static assets (`public/`).
- PostgreSQL is used via `pg` and a connection pool in `database.js`. Use `prepare(sql).get/all/run(...)` wrappers to read/write rows.
- Shipping and carrier integration is encapsulated in `services/`:
  - `services/shippingManager.js` is the façade used throughout the app.
  - Carrier adapters: `services/fedexService.js` and `services/upsService.js` (auth, rates, create label, tracking).
- Payments: Stripe is used (`stripe` package) in `server.js` (checkout and webhook at `/webhook/stripe`). Razorpay support exists for India flows.

2) Key developer workflows
- Install & run locally:
  - npm install
  - copy `.env.example` -> `.env` and fill DB/STRIPE/FEDEX keys
  - npm run dev  (or on Windows: npm run start:win)
  - The `start-server.ps1` script checks port/node_modules and then runs `node server.js`.
- Database initialization: the app calls `initializeTables()` and `seedAdminUser()` at startup (look in `database.js`). There is no separate migration tool; startup will create missing tables.
- Stripe webhook: set `STRIPE_WEBHOOK_SECRET` and POST to `/webhook/stripe` (server expects raw body). For local webhook testing use a tunneling tool and set the secret.

3) Project-specific conventions & patterns
- SQL helper: prefer `prepare(sql).get(params)` / `.all(params)` / `.run(params)` from `database.js` rather than directly using the pool. This file also logs slow queries (>1s).
- Logging: use `winston` logger (configured in `server.js` and `database.js`). Write structured logs to `combined.log` and `error.log`.
- Shipping: always go through `ShippingManager` (it normalizes services and selects the best rate). To add a carrier, implement the same adapter surface (authenticate, getRates, createShippingLabel, trackPackage) and register it in `shippingManager.js`.
- Environment differences:
  - In development: CSP is disabled, CORS = true, uploads directory is `./uploads`.
  - In production: uploads use `/tmp/uploads`, labels use `/tmp/labels`, rate limiting is enabled, and CSP is enforced.
- Business rules found in code (use these exact checks):
  - Bids must be numeric, >0 and in increments of 5 (see `/auction/:id/bid` in `server.js`).
  - Auction creation defaults to 10 days in admin flows (see `/admin/auctions`).
  - Allowed brands are filtered via `allowedBrand()` inside `server.js` (Nike, Adidas, Reebok, New Balance, Jordan, Yeezy, etc.).

4) Integration points & env variables (most important)
- PostgreSQL: prefer `DATABASE_URL` or set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (see `database.js`).
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CLIENT_ID` (connect flows live under `/admin/connect`).
- Razorpay: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (optional flows in `server.js`).
- FedEx: `FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET`, `FEDEX_ACCOUNT_NUMBER`, `FEDEX_METER_NUMBER`, `FEDEX_BASE_URL` (services/fedexService.js).
- UPS: `UPS_CLIENT_ID`, `UPS_CLIENT_SECRET`, `UPS_ACCOUNT_NUMBER`, `UPS_ACCESS_LICENSE_NUMBER`, `UPS_BASE_URL`.
- App/runtime: `SESSION_SECRET`, `NODE_ENV`, `AUTO_GENERATE_LABELS`, `SHIP_FROM_*` variables for default sender address.

5) Where to look for examples
- Auth/session flows: `server.js` routes under `/register`, `/login`, `/logout`.
- Checkout & orders: `server.js` endpoints `/checkout/:auctionId`, `/buy-now/:productId`, and webhook handling at `/webhook/stripe`.
- Shipping flows (rate -> create label -> save): search `shippingManager.createOptimalShipment`, `/admin/shipping/*` routes and `services/*` adapters.
- CSV import: `POST /admin/import` uses `csv-parse` and enforces allowed brands (see `server.js` import handler).

6) Quick rules for making edits
- Use the DB helper `prepare(...)` for new queries and update `initializeTables()` if you add new tables.
- Keep secrets in environment variables; never hardcode keys in source.
- Preserve existing logging calls rather than printing to console; prefer `logger.info/warn/error` for consistent observability.

7) Missing or absent conventions
- There is no test suite or linter configuration present. When adding features, include at least one tiny integration test or an example script and document how to run it.

If anything here is unclear or you want more detail for a particular area (DB schema, adding a carrier, or payment webhook debugging), tell me which section to expand and I will iterate.
