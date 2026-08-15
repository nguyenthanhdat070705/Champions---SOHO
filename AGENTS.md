# Project agent memory

SoHo "Thiết lập cửa hàng" — a mobile-first, Vietnamese, MoMo-style **PWA** for
household businesses. Functional 01: onboarding that creates the store's
operating profile. Functional 02: the "Trang Hôm nay" (Today) dashboard —
read-only daily revenue/attention view. Functional 03: "Tạo bill & thanh toán" —
the POS golden flow (chọn hàng → giỏ → cash/QR → biên nhận), returns/refunds and
inventory. Functional 04: "Hàng hóa & dịch vụ" — full product catalog management
(searchable list, create/edit goods|service, categories, archive/deactivate, price
history, AI label-photo → draft). Functional 05: "Tồn kho cơ bản" — the reliable inventory
ledger: on-hand/available views, manual adjustments (reason + optimistic version), movement
reversal, and stock counts (kiểm kê) with blind counting + atomic variance posting. Functional 10:
"Trợ lý SoHo" — a Vietnamese, grounded, read-only AI chat assistant over the merchant's own data.
Vite + React + TS SPA. F1/F2 reads talk **directly to Supabase** under RLS; **F3/F4/F5
money/inventory/catalog mutations and the F10 assistant go through the combined Node
server**, which also hosts the pre-existing PayOS API. Specs:
`/home/nguye/firstmate/data/soho-onboarding-app/soho-functional-01.md`,
`/home/nguye/firstmate/data/soho-today-dashboard/soho-functional-02.md`,
`/home/nguye/firstmate/data/soho-pos-qr/soho-functional-02-03.md` (F03 section
starts at "ĐẶC TẢ FUNCTIONAL 03"),
`/home/nguye/firstmate/data/soho-f4-catalog/soho-functional-04.md`,
`/home/nguye/firstmate/data/soho-f5-inventory/soho-functional-05.md`,
`/home/nguye/firstmate/data/soho-ai-assistant/soho-functional-10.md` (+ the
`amendment-01-official-spec.md` deltas: source cards, quick actions, microcopy).

## Commands
- `npm run dev` — Vite dev server.
- `npm run build` — typecheck (`tsc --noEmit`) then `vite build` → `dist/`.
- `npm start` — combined server (`server/index.js`) serves `dist/` + PayOS API on `$PORT`.
- `npm test` — `vitest run` (pure-logic unit tests in `src/**/*.test.ts`) **and**
  `node --test test/*.test.js` (ported PayOS server tests). Both must pass.

## Architecture
- SPA entry `src/main.tsx` → `src/App.tsx` (auth state machine: loading / onboarding / app).
- Onboarding: `src/onboarding/` (8-step flow in `Steps.tsx`, orchestration + draft/resume
  + idempotent finish in `OnboardingFlow.tsx`).
- Post-onboarding app: `src/dashboard/` (MoMo-style Home, real routed pages, `react-router`).
- Today dashboard (Functional 02): `src/dashboard/Home.tsx` **is** the Today screen;
  `useTodayDashboard.ts` fetches + caches (localStorage `soho-today:v1:<merchantId>`, offline
  fallback). Pure logic is unit-tested in `src/lib/`: `dashboard.ts` (snapshot type,
  `derivePriorityItems`, `selectZeroState`), `summary.ts` (AI summary — only the deterministic
  spec-9.4 fallback exists; provider-pluggable), `format.ts` (`formatVnd` VND đồng). Data access
  is `getTodayDashboard`/`loadLowStockProducts`/`loadOpenActionItems` in `db.ts` (the one seam a
  future server layer replaces).
- Data/logic layer: `src/lib/` — `supabase.ts`, `auth.ts` (email+password, **isolated** so a
  future phone-OTP swap is one file), `db.ts` (all table/RPC access), `validators.ts` (pure,
  unit-tested), `enums.ts` (DB enum values + VN labels), `config.ts`.
- Combined server: `server/` + `api/payos/` were **ported from** the existing Railway service
  (repo `github.com/nguyenthanhdat070705/Champions---SOHO`). `server/application.js` is the only
  adapted file (serves `dist/` with SPA deep-link fallback; PayOS routes + `/health` unchanged; it
  also dispatches `/v1/*` to the F3 router).
- **Functional 03 server (`server/f3/`):** every money/inventory mutation runs in ONE real Postgres
  transaction via the `pg` **session pooler** (`DATABASE_URL`, server-only `.env`, never committed).
  `router.js` (spec-11 routes) → `auth.js` (verify JWT + membership/role — the pooler bypasses RLS so
  this is the ONLY tenant guard), `sales.js` (preview/draft/lock), `payments.js` (cash finalize + QR
  create/confirm/cancel), `returns.js`, `catalog.js`, `receipts.js`. `pricing.js` is pure + unit-tested
  (`test/f3-pricing.test.js`); error contract in `errors.js` (`test/f3-errors.test.js`). PayOS calls via
  `payos.js` (reuses `server/payos/client.js`).
- **Functional 03 client:** `src/sales/` (the `SalesFlow` multi-step golden flow + `cartStore.ts` pure
  cart, unit-tested), `src/orders/` (bill list + detail + return flow). All F3/F4 server
  calls go through `src/lib/api.ts` (typed, attaches the Supabase bearer, maps the spec-11.1 error
  contract to `ApiError.code`). QR payload rendered with the `qrcode` dep.
- **Functional 10 AI Assistant (`server/assistant/` + `src/assistant/`):** "Trợ lý SoHo"
  chat. Server route `POST /v1/assistant/chat` (registered in `server/f3/router.js`, reuses F3
  `verifyUser`+`requireMembership` — any ACTIVE member; membership is the tenant guard). Flow in
  `index.js`: `facts.js` builds a merchant-scoped FACTS pack via **direct SQL over the pooler**
  (mirrors the F2 window math — do NOT call `get_today_dashboard` from the pooler, it FORBIDs) →
  `prompt.js` system instruction → `gemini.js` (`gemini-flash-latest`, structured JSON, 6s timeout,
  one retry) → post-check: forbidden terms + `numbers.js` grounding (every digit-run in the reply
  must appear in the FACTS text) → on any failure/AI-off, `fallback.js` deterministic answerer
  (grounded by construction). `registry.js` = allowlisted source-card / "Làm tiếp" deep-link keys
  (model emits keys, server resolves label+route). Pure logic unit-tested in `test/assistant-*.test.js`;
  4th bottom-nav tab `/tro-ly`. GEMINI_API_KEY is server-only `.env`.
- **Functional 04 server (`server/f3/`, reuses F3 auth/pool/audit/errors):** `products.js` is the
  catalog service — `insertProductTx` (shared atomic core: product + price-history + 'opening'
  movement + audit, used by BOTH full create AND POS `quickCreateProduct`), `createProduct`
  (idempotent), `updateProduct` (row_version If-Match), `changeProductStatus`, `searchProducts`,
  `getProductDetail`, `lookupByBarcode`, categories CRUD. `text.js` = pure `normalizeSearchName`/
  `normalizeSku` (unit-tested `test/f4-catalog.test.js`). `gemini.js` = label-photo → structured draft
  (server-only `GEMINI_API_KEY`, model `gemini-flash-latest`, 429-retry-once → `AI_PREVIEW_FAILED`);
  `ai_products.js` orchestrates preview/confirm + writes `ai_product_suggestions`. Routes added to
  `router.js` under `/v1/merchants/:mid/{products,products/:id,products/:id/status,products/barcode/:code,
  products/ai/*,categories}`.
- **Functional 04 client:** `src/catalog/` — `CatalogPage.tsx` **is** the Kho screen (route `/kho`,
  search + status/type/category chips + FAB), `ProductForm.tsx` (create/edit + AI photo review sheet),
  `ProductDetail.tsx` (info + history timeline + status actions), `parts.tsx` (category/type sheets,
  confidence badge). Pure client helpers + validation in `src/lib/catalog.ts` (unit-tested, mirrors
  `text.js`). `src/inventory/` was removed at F04 and **re-added for F05** (see below).
- **Functional 05 server (`server/f5/`, reuses F3 auth/pool/audit/errors):** `movements.js` is the
  shared post-movement core — `postMovementTx` (lock level FOR UPDATE → block negative → append
  immutable movement + `balance_after` → bump `inventory_levels.row_version` → idempotent on the
  `(product_id, movement_type, reference_type, reference_id)` unique index) + `deterministicUuid`
  (Idempotency-Key → durable movement `reference_id`). `inventory.js` = overview/ledger/reconciliation
  reads (ledger resolves each movement's source to a bill/return/count deep-link). `adjustments.js` =
  preview + `postAdjustment` (409 `INVENTORY_BALANCE_CHANGED` on stale level `row_version`) +
  `reverseMovement` (appends `reversal` linked via `original_movement_id`; the unique index blocks a
  second reverse → 409 `MOVEMENT_ALREADY_REVERSED`; same idem-key replays via `source_line_id` marker).
  `counts.js` = session create (snapshot `expected_at_start`, blind default ON) / save / review /
  atomic `postCount` (count_adjustment per line, lock ordering by product_id) / cancel. Pure logic
  unit-tested in `test/f5-inventory.test.js`: `count-math.js` (variance, `countPostDelta` =
  adjustment_to_counted_at_post), `reasons.js` (fixed reason list, OTHER needs a note), `rules.js`
  (reversible types + deltas). Routes wired into `server/f3/router.js` under
  `/v1/merchants/:mid/{inventory,inventory/:productId,inventory/reconciliation,inventory/adjustments*,
  inventory/movements/:id/reverse,inventory-counts*}`.
- **Functional 05 client (`src/inventory/`):** `InventoryPage.tsx` (route `/ton-kho`, overview +
  Thấp/Hết/Âm filters + adjust FAB), `InventoryLedger.tsx` (`/ton-kho/:productId` — big on-hand,
  timeline, reverse), `CountCreate.tsx` + `CountSession.tsx` (counting→review→post) + `CountList.tsx`
  (`/ton-kho/kiem-kho*`), `Reconciliation.tsx` (`/ton-kho/doi-chieu`, owner), `parts.tsx` (state badge +
  the two-step `AdjustSheet`). Pure helpers mirror the server in `src/lib/inventory.ts` (unit-tested).
  All calls go through `src/lib/api.ts`. `MerchantContext` now exposes `role` (via `loadMyRole`) for UI
  gating — owner/manager adjust/count/reverse; cashier is view-only (server enforces the same).

## Sharp edges (read before changing)
- **Do NOT run DB migrations.** The Supabase schema (10 tables, enums, RLS, triggers, and the
  `create_merchant_onboarding` RPC) is already deployed per spec §6 and is the source of truth.
  Enum values must match `src/lib/enums.ts` (e.g. `food_beverage`, not `fnb`).
- **Deploy target = the existing PayOS Railway service.** Keep PayOS env var **names** identical
  (see `.env.example`) and the webhook path `/api/payos/webhook` byte-identical, or payments break.
  Never commit any PAYOS_*/service_role/secret value — only the publishable Supabase anon key.
- **RLS is enforced client-side**; `db.ts` sets owning ids explicitly to satisfy WITH CHECK policies.
- **Never store secrets in `onboarding_progress.draft_data`** (no password, no raw account number —
  only the masked `******1234` form). Account masking + tax-code rules live in `validators.ts`.
- **Idempotency (FR-05):** one idempotency key per onboarding session, reused by the draft upsert
  and the finish RPC; a repeat finish returns the same merchant. Finish is also single-flighted.
- `merchants.tax_code_normalized` is **globally unique**; a duplicate on finish is mapped to a
  friendly VN message (`friendlyFinishError` in `OnboardingFlow.tsx`), not the raw Postgres error.
- Auth: email+password with `mailer_autoconfirm` enabled on the project (no confirmation email).
  Test accounts use throwaway `soho-crew-test+<n>@soho.test` addresses (cannot delete auth users).
- **Functional 02 numbers come from the `get_today_dashboard` RPC** (already deployed). The RPC
  is `security invoker` + does `private.has_merchant_role`, so a privileged psql/service-role call
  raises `FORBIDDEN`; verify the RPC via the authenticated client, or recompute with direct SQL.
  Clients are read-only on orders/payments/etc. — seed verification data with privileged access via
  `test/seed-today-dashboard.sql` (parameterized by `:merchant_id`; covers spec MET-01..07 +
  INV-01/02 with expected values in comments). Business day = Asia/Ho_Chi_Minh 00:00.
- **F3 partial refunds keep `orders.status='paid'`, NOT `partially_refunded`.** The deployed F2
  `get_today_dashboard` RPC counts gross only for `status in ('paid','refunded')`; setting an order to
  `partially_refunded` would silently drop it from gross. Only a FULLY-returned bill is set to
  `refunded` (still counted; the succeeded refund is subtracted). This keeps gross/refund/net
  reconciliation exact — do not "fix" it to use `partially_refunded` without also fixing the RPC.
- **F3 schema quirks (deployed migration 03, don't re-derive):** `refund_status` has only
  `pending/succeeded/failed` (NO `cancelled`); `has_merchant_role(p_merchant_id, p_roles)` is 2-arg (the
  spec's finalize skeleton shows 3 — ignore it, F3 enforces roles in Node, not via that fn). Cashier
  manual-discount ceiling is a Node constant `CASHIER_DISCOUNT_LIMIT_PCT` in `sales.js` (no
  merchant_settings column). ai_transaction_suggestions unique is `(merchant_id, source_hash)`.
- **Idempotency (F3):** payment/refund POSTs need an `Idempotency-Key` header, unique per
  (merchant, key). `finalizeCash` re-checks the key AFTER taking the order `FOR UPDATE` lock so two
  concurrent same-key taps return the SAME payment (SALE-03), not a 409. `provider_event_id` = PayOS
  webhook `reference` dedupes duplicate webhooks (QR-03).
- **PayOS webhook (`/api/payos/webhook`)**: keeps the byte-compatible test-event + forward behavior;
  when `DATABASE_URL` is set it instead drives the F3 confirm transaction. Real webhooks can't reach a
  laptop, so the **dev-only** `POST /v1/dev/payos/simulate` (guarded by `SOHO_DEV_ENDPOINTS=1` +
  non-production `NODE_ENV`) confirms QR locally. returnUrl / "Đã chuyển khoản" NEVER mark paid — only a
  verified webhook (or server reconcile) does.
- **F3 live E2E:** `node --env-file=.env test/f3-e2e.mjs` (needs the server running with `.env`) runs the
  whole spec 13.3 matrix (SALE/INV/QR/RET/RLS) against the real DB + PayOS on its own throwaway merchant
  (`soho-crew-test+f3@soho.test`). It is NOT in `npm test` (not a `*.test.js`); `npm test` must run
  WITHOUT `DATABASE_URL` in the env or the PayOS-forward server test fails.
- **F10 live E2E:** `AI_BASE=http://localhost:<port> node --env-file=.env test/assistant-e2e.mjs`
  (server running with `.env`) covers grounding, source cards, honest out-of-data, cross-tenant 403,
  and the Gemini-down fallback (spawns a 2nd server with an invalid key) on `soho-crew-test+ai@soho.test`.
  `.env` needs `GEMINI_API_KEY` (server-only, never committed). When two lanes share the box, pick a
  non-3000 `PORT` to avoid the parallel lane's server.
- **F4 schema quirks (deployed migration 04-06, don't re-derive):** `public.products` has **NO
  `created_by`** column (spec skeleton showed one; the migration dropped it — actor lives in the audit
  row). SKU unique is `(merchant_id, sku)` **case-SENSITIVE** — `text.js` uppercases SKU so it behaves
  case-insensitively; barcode unique is partial `where barcode is not null`. `ai_product_suggestions.
  input_kind ∈ {voice,image,barcode}` only (no `category`) — the deterministic category hint rides in
  the image row's `payload` / is returned inline, never persisted with a `category` kind.
  `inventory_movements.movement_type` includes `opening`; product-level `low_stock_threshold` wins over
  the inventory-level one (mapper exposes both). **POST /products idempotency is IN-PROCESS** (Map by
  merchant+key, single-flight) since a durable key table would need a migration — fine for the
  single-instance pilot server; cross-device dup is still caught by the DB unique indexes.
- **Service worker (`public/sw.js`) must NOT cache `/v1/` (or `/api/`)** — its cache-first branch
  covers all same-origin GETs, so any API path it doesn't exclude gets served stale (broke F04
  read-after-write; the `/v1/` exclusion + `soho-shell-v2` bump fix it). Never add an API path the SW
  will cache.
- **F5 schema quirks (deployed, don't re-derive):** table is `inventory_levels` (cols `on_hand`,
  `reserved_qty`, `low_stock_threshold`, `row_version`; **no location_id** — single-location MVP),
  movement cols are `reference_type/reference_id` + `created_by/created_at` (NOT source_/posted_).
  `inventory_movements` has a **`balance_after >= 0` CHECK** (DB-level negative-stock backstop) and a
  unique `(product_id, movement_type, reference_type, reference_id)` (idempotency + double-reversal
  guard). Enum `inventory_movement_type` = sale/sale_return/damage_writeoff/manual_adjustment/opening/
  count_adjustment/reversal/purchase_receipt. `inventory_count_items` has **no `variance_qty`** (server
  computes it) and **`inventory_reconciliation_findings` does NOT exist** → reconciliation is computed
  live (spec 9.4 query), display-only, never auto-fixed. There are NO DB functions — all F5 txns run in
  Node via the pooler (F3/F4 pattern).
- **F5 negative stock is BLOCKED** (founder decision, no owner-override UI): adjustments/counts that
  would drive `on_hand < 0` → 409 `INSUFFICIENT_STOCK` (the `balance_after >= 0` CHECK is the backstop).
- **F5 made `inventory_levels.row_version` a real optimistic-lock counter** — F3 sale/return posting and
  F4 opening upsert now bump it too (nothing reads it besides F5's adjustment version check; safe).
  The adjustment preview returns the level `row_version`; a stale one at post → 409
  `INVENTORY_BALANCE_CHANGED` + current snapshot.
- **F5 count posting = adjustment_to_counted_at_post** (spec 4.3): post delta = counted − CURRENT
  on_hand (locked), so a sale during the count is absorbed; review shows both `expected_at_start` and
  `current_before_post`. A blank/`MISSING` line is never treated as 0 (no movement). Only manager/owner
  may adjust/count/reverse (server-enforced; cashier view-only).
- **F5 live E2E:** `F5_BASE=http://localhost:<port> node --env-file=.env test/f5-e2e.mjs` (server
  running with `.env` + a non-3000 `PORT`) runs the spec 12.3 P0 matrix (INV-01/02/03, adjustment
  idempotency + version-conflict + negative-block, reversal + double-reversal, count blind/review/atomic-
  post/blank≠0, RLS, reconciliation-clean) on `soho-crew-test+f5@soho.test` (`test/f5-setup.mjs`
  `ensureF5Merchant`, never a real merchant). Not in `npm test` (`.mjs`, needs DB).
- **F5 screens with a `.form-foot` bottom CTA must be `immersive` in `AppShell.tsx`** (bottom-nav
  hidden) or the fixed footer overlaps the tab bar and taps mis-fire — `/ton-kho/:productId`,
  `/ton-kho/kiem-kho/*` are immersive; the FAB/list screens (`/ton-kho`, `/ton-kho/kiem-kho`,
  `/ton-kho/doi-chieu`) keep the nav.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
