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
reversal, and stock counts (kiểm kê) with blind counting + atomic variance posting. Functional 06:
"Nhập hàng" — goods receiving: form-first purchase receipts (supplier snapshot, lines, server totals)
+ a photo path (chụp chứng từ → private storage → Gemini extraction → line-match review) that raise
stock via one 'purchase_receipt' movement per line and create ONE pending accounting_event, all
atomic; posted receipts are immutable (reverse appends opposite movements). Functional 07: "Ghi nhận chi phí" — the expense recorder:
quick manual/photo(Gemini)-draft → server-computed totals → atomic post (expense + payment fact +
ONE accounting_event pending) with duplicate detection, immutable-once-posted + reversal (đảo bút
toán). Functional 08:
"Hộp chứng từ" — the document box: upload/view/link/archive every photo (JPG/PNG/WEBP) with
short-lived signed URLs, server-computed hash dedupe, and links to bills/expenses/receipts. Functional 10:
"Trợ lý SoHo" — a Vietnamese, grounded, read-only AI chat assistant over the merchant's own data.
Functional 11: "Sổ thu–chi tự động" — an automatic cashbook: confirmed money events (payment/refund
success, purchase/expense accounting_events) map deterministically to one posted cashbook entry (+
source link) when certain, or a "Cần xem" review item when not; posted lines are immutable, fixed by
appending an opposite adjustment (đảo). Coverage/summary are computed live per period. Functional 12:
"Đối soát và xử lý sai lệch" — a deterministic reconciliation engine that detects mismatches across
bill/payment/inventory/receipt/expense sources, materialises fingerprint-deduped issues + immutable
evidence in one txn, and guides resolution (evidence-first; the engine never mutates source data). Functional 13:
"Báo cáo kinh doanh tối giản" — immutable snapshot reports: a period builder (ngày/tuần/tháng/quý) computes
metric rows (doanh thu gộp/thuần/hoàn, theo kênh/ngày, số bill, bill TB, top SP, chi phí theo nhóm, nhập hàng,
hao hụt, tiền thu, kết quả tạm tính) + per-source data-quality coverage in ONE txn, content-hashed + idempotent;
rebuild = new revision superseding the old (immutable); read screen with coverage banner, drill-down that
reconciles to the number, period compare and CSV export.
Vite + React + TS SPA. F1/F2 reads talk **directly to Supabase** under RLS; **F3/F4/F5
money/inventory/catalog mutations and the F10 assistant go through the combined Node
server**, which also hosts the pre-existing PayOS API. Specs:
`/home/nguye/firstmate/data/soho-onboarding-app/soho-functional-01.md`,
`/home/nguye/firstmate/data/soho-today-dashboard/soho-functional-02.md`,
`/home/nguye/firstmate/data/soho-pos-qr/soho-functional-02-03.md` (F03 section
starts at "ĐẶC TẢ FUNCTIONAL 03"),
`/home/nguye/firstmate/data/soho-f4-catalog/soho-functional-04.md`,
`/home/nguye/firstmate/data/soho-f5-inventory/soho-functional-05.md`,
`/home/nguye/firstmate/data/soho-f6-receiving/soho-functional-06.md`,
`/home/nguye/firstmate/data/soho-f8-documents/soho-functional-08.md`,
`/home/nguye/firstmate/data/soho-f13-reports/soho-functional-13.md`,
`/home/nguye/firstmate/data/soho-ai-assistant/soho-functional-10.md` (+ the
`amendment-01-official-spec.md` deltas: source cards, quick actions, microcopy),
`/home/nguye/firstmate/data/soho-f11-cashbook/soho-functional-11.md`.

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
- **Functional 06 server (`server/f6/`, reuses F3 auth/pool/audit/errors + the F5 movement service):**
  `receipts.js` is the core — create/get/list/update/`putItems` (replaces the full line set, snapshots
  name/unit, server-computes line/subtotal/grand totals via `receiving-math.js`, rejects duplicate
  product) / `previewReceipt` (per-line stock impact, sets `ready`) / `postReceipt` (ONE txn: one
  `purchase_receipt` movement per line via `postMovementTx`, product_id lock order, + ONE
  `accounting_event` `purchase_received` pending, idempotent) / `cancelReceipt` / `reverseReceipt`
  (opposite `reversal` movements + a `reversed` event; blocked if it would drive stock negative).
  `documents.js` = upload + content-hash dedupe + Gemini extract + product line-match; `storage.js` =
  the private `documents` bucket (provisioned idempotently over the pooler) uploaded/signed with the
  CALLER's JWT (no service_role); `gemini.js` = receipt photo → structured draft; `suppliers.js` =
  minimal suppliers. `receiving-math.js` is pure + unit-tested (`test/f6-receiving.test.js`). Routes
  under `/v1/merchants/:mid/receiving/{receipts,receipts/:id/*,suppliers,documents,documents/:id/*}`.
- **Functional 06 client (`src/receiving/`):** `ReceivingList.tsx` (route `/nhap-hang`, list + method
  chooser FAB), `ReceiptScreen.tsx` (loads `/nhap-hang/:id` → `ReceiptEditor` while editable, else
  read-only `ReceiptDetail`), `parts.tsx` (supplier/product pickers, line-edit + AI review sheets).
  Pure mirror in `src/lib/receiving.ts` (unit-tested). The F5 ledger now deep-links
  `purchase_receipt` movements back to `/nhap-hang/:receiptId`. Home + Inventory expose a "Nhập hàng"
  entry; owner/manager only (server enforces).
- **Functional 07 server (`server/f7/`, reuses F3 auth/pool/audit/errors + F5 `idem.js`):** `expenses.js`
  is the service — `createDraft` (idempotent; source-backed dedup via ON CONFLICT on the partial index),
  `updateDraft` (If-Match row_version), `postExpense` (atomic: recompute totals → duplicate gate →
  payment fact snapshot → ONE accounting_event `expense_posted` pending → status posted; replays a posted
  expense; VERSION_CONFLICT on stale expectedVersion), `reverseExpense` (status reversed + `expense_reversed`
  event; double-reverse blocked by the events unique + status), duplicate findings + decisions.
  Pure logic unit-tested in `test/f7-expenses.test.js`: `money.js` (server-owned totals, client total never
  trusted), `duplicates.js` (amount + date±1 + payee-Jaccard / same-doc signals). `gemini.js`
  (`gemini-flash-latest`, receipt photo → structured draft, AI_PREVIEW_FAILED fallback), `ai.js`
  (persists a `source_documents` metadata row by content hash + extracts), `categories.js` (seeds the
  GLOBAL default set once/process). Routes added to `server/f3/router.js` under
  `/v1/merchants/:mid/{expense-categories,expenses,expenses/ai/preview,expenses/:id[,/post,/reverse,/duplicates,/duplicate-decision]}`.
- **Functional 07 client (`src/expenses/`):** `ExpensesPage.tsx` (route `/chi-phi`, month total + status
  filters + FAB), `ExpenseForm.tsx` (`/chi-phi/moi` — the quick flow: photo→OCR prefill, amount/lines,
  category chips, payment picker, duplicate sheet), `ExpenseDetail.tsx` (`/chi-phi/:id` — detail + reverse
  + duplicate-finding decisions), `parts.tsx` (StatusBadge/CategoryChips/PaymentPicker/DuplicateSheet).
  Pure helpers in `src/lib/expenses.ts` (unit-tested). Home grid has a "Chi phí" tile; `/chi-phi/moi` and
  `/chi-phi/:id` are `immersive` in `AppShell.tsx` (they carry a `.form-foot` CTA).
- **Functional 08 server (`server/f8/`, reuses F3 auth/pool/audit/errors + F5 idem):** `documents.js` is
  the document-box service — `uploadDocument` (server-computed SHA-256 → merchant dedupe → storage
  upload under the caller's JWT → `source_documents` insert; on DB failure the object is removed to avoid
  an orphan), `listDocuments` (filters + batch-signed thumbnails, one storage call, not audited),
  `getDocumentDetail`, `getContent` (status/purpose check → access-event → short-lived signed URL),
  `addLink`/`removeLink`/`listLinkCandidates`, `setArchiveState`. `resolveLinks` UNIONs F8 `document_links`
  with F6/F7 back-refs (`expenses.document_id`, `purchase_receipts.document_id`) so their docs appear
  linked automatically — no back-fill. `storage.js` = per-request Supabase client on the user JWT (upload/
  sign/remove). `types.js` = pure allowlists/validators (unit-tested `test/f8-documents.test.js`). Routes
  added to `server/f3/router.js` under `/v1/merchants/:mid/documents{,/link-candidates,/:id,/:id/content,
  /:id/links,/:id/links/:linkId,/:id/archive}` (upload uses a 20 MB body cap; other routes stay 1 MB).
- **Functional 08 client (`src/documents/`):** `DocumentsPage.tsx` **is** the Hộp chứng từ screen (route
  `/chung-tu`, search + linked/type chips + upload FAB), `DocumentDetail.tsx` (`/chung-tu/:id` — signed-URL
  preview, metadata, links panel, access history, archive/restore), `parts.tsx` (badges + `UploadSheet` +
  `LinkSheet`). Pure helpers/validators in `src/lib/documents.ts` (unit-tested, mirrors `types.js`).
  Home service grid + `/cai-dat` entry point; owner/manager/cashier upload+link, only owner/manager
  remove-link/archive (server-enforced).
- **Functional 09 server (`server/f9/`, reuses F3 auth/pool/audit/errors + F5 idem/deterministicUuid):**
  "Hóa đơn điện tử". Pure + unit-tested: `mapping.js` (versioned retail tax-code table, `RULE_SET_VERSION`),
  `totals.js` (tax-INCLUSIVE extraction so invoice total == bill total; canonical payload + sha256
  `payload_hash`), `validation.js` (seller/buyer MST + line rules), `state.js` (reducer — no terminal
  regress, out-of-order guard), `provider.js` (the `EInvoiceProvider` interface + **MockProvider**: HMAC
  webhook sign/verify, deterministic providerRef, placeholder XML/PDF). `invoices.js` = the service:
  create draft (order FOR UPDATE = INV-02 guard) / buyer autosave (If-Match) / validate (server recompute
  → payload_hash) / **submit = freeze+enqueue tx then post-commit provider call** (deterministic
  `client_request_id`=`soho-<id>-<rowVersion>` → durable double-tap dedupe) / webhook `processProviderEvent`
  (signature → dedupe on `(provider_code,provider_event_id)` → reducer) / retry-draft / relations
  (adjustment/replacement) / artifacts. Routes wired into `server/f3/router.js` under
  `/v1/merchants/:mid/{e-invoices*,orders/invoice-eligible}` + `/v1/webhooks/e-invoice/:provider` (no auth,
  signature is the trust boundary) + dev `/v1/dev/e-invoice/simulate`. Unit tests `test/f9-*.test.js`.
- **Functional 09 client (`src/einvoice/`):** `EInvoicePage.tsx` (route `/hoa-don`, list+filters+FAB),
  `CreateInvoice.tsx` (`/hoa-don/tao`, eligible paid bills → draft), `InvoiceDetail.tsx` (`/hoa-don/:id` —
  ONE lifecycle screen: seller readiness → buyer form → lines/tax → validate → confirm/submit → đang xử lý
  → accepted artifacts/relations | rejected retry; polls status while submitting; dev-only "Mô phỏng"
  accept/reject drives the mock). `parts.tsx` (status badge, `MockProviderBanner`, buyer form, ack +
  relation sheets). Pure mirror + types in `src/lib/einvoice.ts` (unit-tested). Entry: Home grid "Hóa đơn"
  tile + a Thuế-page link. `/hoa-don/:id` and `/hoa-don/tao` are `immersive` in `AppShell.tsx`.
- **Functional 11 server (`server/f11/`, reuses F3 auth/pool/audit/errors + F5 idem/deterministicUuid):**
  `mapping.js` is the pure deterministic rule table (unit-tested `test/f11-cashbook.test.js`):
  `MAPPINGS[sourceType:eventType]` → direction/entryType/method/autoPost, `classifySource` (post|review|
  skip; missing date/method/amount downgrades an auto-post to review — never guesses), `sourceHash`,
  taxonomy + reason codes, `RULE_VERSION`. `ingest.js` = the write core: `postEntryTx` (entry + source
  link atomic, idempotent on the links unique via a SAVEPOINT so no orphan entry), `upsertReviewTx`,
  `ingest{Payment,Refund,AccountingEvent}ById`, `syncMerchant` (on-demand gap-fill scan), plus
  `bestEffortIngest` used by the F3 post-commit hooks (finalizeCash / confirmQrPayment / confirmRefund).
  `cashbook.js` = reads + review + reverse: `computePeriod` (pure, VN-local), `getSummary` (+ live
  `coverage`), `listEntries` (cursor), `getEntry`, review `patch/preview/post/exclude`, `createManualDraft`,
  `reverseEntry`. Routes wired into `server/f3/router.js` under `/v1/merchants/:mid/cashbook/*`.
- **Functional 11 client (`src/cashbook/`):** `CashbookPage.tsx` (route `/so-quy`, overview + period tabs
  + thu/chi/chênh + coverage + Cần xem banner + entries list + Ghi tay FAB + sync), `CashbookEntry.tsx`
  (`/so-quy/:id`, detail + source drill-down + reverse sheet), `ReviewQueue.tsx` (`/so-quy/can-xem`),
  `ReviewItem.tsx` (`/so-quy/can-xem/:id` — fill → preview → post, immersive), `ManualDraftSheet.tsx`,
  `parts.tsx`. Pure mirror `src/lib/cashbook.ts` (unit-tested `cashbook.test.ts`). All calls via
  `src/lib/api.ts`. Home grid + reads are any member; writes owner/manager (server enforces).
- **Functional 12 server (`server/f12/`, reuses F3 auth/pool/audit/errors):** the reconciliation
  engine. `fingerprint.js` = pure `fingerprint(rule,ver,entityKey)` (sha256, PII-free) + `contentHash`
  (canonical-JSON of evidence facts) — unit-tested `test/f12-rules.test.js`. `rules.js` = the
  deterministic rule catalog (7 rules over F03/F05/F06/F07 data): each has a `detectSql` ($1=merchant,
  $2=as_of) + a single-entity `recheckSql` ($1=merchant, $2=entityId, inlines `now()`) + a pure `map(row)`
  → {entityKey, source, facts, deepLink}. `engine.js` = `createRun` (ONE txn: idempotent run on
  (merchant,idem_key); per rule → fingerprint + `ON CONFLICT (merchant,fingerprint) WHERE status in
  (active) DO NOTHING` issue upsert + content-hash-deduped evidence; verify-before-close auto-resolve of
  active issues NOT re-detected by a clean rule; partial-coverage counters) + read-only `dryRun` (no
  writes — used against real merchants). `issues.js` = `getSummary`/`listIssues`/`getIssue` (with live
  recheck = snapshot-vs-now) + transitions `markReview`/`requestAction` (intent_id-idempotent handoff →
  action_pending; F12 never mutates source data) / `ignoreIssue` (reason-gated → dismissed, suppresses
  re-creation). Routes under `/v1/merchants/:mid/reconciliation/*` (run+resolve owner/manager, reads any
  member). NB: router imports F12 `getSummary as getReconSummary` (name clash with F11's getSummary).
- **Functional 12 client (`src/reconciliation/`):** `ReconciliationPage.tsx` (route `/doi-soat`, centre +
  queue: cleanliness hero, "Chạy đối soát" run CTA, family cards, impact/status filters), `IssueDetail.tsx`
  (`/doi-soat/:issueId`, immersive — rule callout, snapshot-vs-live evidence, guided actions, dismiss
  sheet), `RunHistory.tsx` (`/doi-soat/lich-su`). Pure helpers `src/lib/reconciliation.ts` (unit-tested).
  Home tile + reads any member; run/resolve owner/manager (server enforces).
- **Functional 13 server (`server/f13/`, reuses F3 auth/pool/audit/errors + F5 `idem.js`):** `catalog.js` =
  the PURE metric formula catalog (code-only — there is NO `report_formula_catalog` table; `FORMULA_VERSION`,
  `METRIC_CATALOG`, period presets, scope/content hashing). `metrics.js` = the metric SQL constants + PURE
  assemblers (`assembleSnapshot`, `coverageStatus`, `snapshotContentHash`) — DB-free so `npm test` unit-tests
  them; the revenue window predicate MIRRORS the deployed F2 `get_today_dashboard` (paid_at window, status in
  ('paid','refunded'), net = gross − succeeded refunds, cash/qr by method) so a same-day snapshot reconciles to
  the đồng. `snapshots.js` = `findOrBuildSnapshot` (advisory-lock per build key → find ready or insert a new
  revision; rebuild supersedes old, old kept immutable) / `getSnapshot` (one grouped DTO powers the whole
  screen) / `listSnapshots` / `compareSnapshots` (compat = same tz/scope/formula/length; % null when base=0) /
  `drilldown` (source rows bounded by the snapshot's period, sum reconciles to the metric, deep-links). `export.js`
  = injection-safe CSV built from the immutable snapshot (parity by regeneration). Routes in `server/f3/router.js`
  under `/v1/merchants/:mid/reports/{snapshots,snapshots/:id[,/drilldown,/exports,/exports/:eid/download],compare}`,
  ALL gated to owner/manager (cashier can't view reports, spec 12.1).
- **Functional 13 client (`src/reports/`):** `ReportsPage.tsx` **is** the Báo cáo screen (route `/bao-cao`,
  period picker + tabs Tổng quan/Bán hàng/Chi phí/Dòng tiền/Tạm tính/Nguồn + coverage banner + compare/export),
  `parts.tsx` (`CoverageChip`/`MetricCard`/`BarList` CSS bars/`DrilldownSheet`/`CompareSheet`). Pure display
  helpers in `src/lib/reports.ts` (unit-tested). All calls via `src/lib/api.ts` (`report*`).
- **Functional 14 server (`server/f14/`, reuses F3 auth/pool/audit/errors + F5 idem/deterministicUuid):**
  "Chốt tiền cuối ngày" (end-of-day cash closing). `closing.js` is PURE (unit-tested
  `test/f14-closing.test.js`): `computeCount` (server-authoritative total/denomination math),
  `expectedCash` (Σ in − Σ out; direction never inferred from sign), variance/reason gates, and the
  `sourceSetHash`/`previewHash`/`contentHash` that make confirm idempotent + previews staleness-safe.
  `service.js` is the txn service: `prepareClosing` (create-or-reuse the active draft + freeze cash
  source snapshots; re-preparing a confirmed closing opens a NEW draft = the re-close path),
  `saveCount` (independent versions, idempotent on client_count_id), `previewClosing` (recompute +
  drift-check → 409 CLOSING_SOURCE_CHANGED), `confirmClosing` (atomic revision + pointer + audit +
  outbox; deterministic revision id = `deterministicUuid('f14-closing-revision:'+draftId)` so a
  double-tap replays the SAME revision), `scanLateSources`/`resolveAttention` (late cash after cut-off
  → attention item, dismiss or re-close). Routes wired into `server/f3/router.js` under
  `/v1/merchants/:mid/{closings,closings/prepare,closings/:id[,/revisions,/attention/scan],
  closing-drafts/:id[,/counts,/preview,/confirm],closing-attention/:id/resolve}`.
- **Functional 14 client (`src/closing/`):** `ClosingPage.tsx` (route `/chot-tien`, list + "Két hôm
  nay khớp chưa?" hero — keeps nav), `ClosingDraft.tsx` (`/chot-tien/moi?date=` — prepare→count
  (total|mệnh giá)→variance→reason→preview→consent→confirm, immersive), `ClosingDetail.tsx`
  (`/chot-tien/:id` — confirmed revision + history + late-source attention + "Chốt lại", immersive),
  `parts.tsx`. Pure mirror `src/lib/closing.ts` (unit-tested `closing.test.ts`). Home grid "Chốt ngày"
  tile. Reads any member; writes owner/manager (server enforces).
- **Functional 15 server (`server/f15/`, reuses F3 auth/pool/audit/errors + F5 idem/deterministicUuid):**
  "SỔ KẾ TOÁN & DỮ LIỆU THUẾ" — TT 152/2025 books from real events. `mapping.js` is the PURE compliance
  core (unit-tested `test/f15-taxbooks.test.js`): the 5-book S-HKD retail set (sales_revenue/cash_book/
  bank_book/expenses/materials_goods), `mapSourceToRecords` (deterministic source→signed-amount book lines;
  a payment → revenue + cash/bank by method; expense/purchase have NO method so NOT split into quỹ/ngân
  hàng), `computeThresholdSplit` (1-tỷ cumulative/year, GTGT 1% + TNCN 0,5% on the over-threshold part),
  `toCsv`/`byteHash` (BOM+CRLF, VND bare int, deterministic), `contentHash` (canonical-JSON sha256).
  `catalog.js` seeds the ONE published `compliance_catalog_versions` row (`VN-HKD-2026.1`, legal_basis →
  TT152/NĐ141/NĐ117) lazily+idempotently. `ingest.js` = record builder: `ingestEventTx` (source receipt
  ON CONFLICT DO NOTHING gate → map → records + record_sources, all one txn; a late source into a locked
  period flips it to `attention`) + `syncRange` (on-demand rebuild-sync). `books.js` = book totals/ledger/
  record detail (watermark-pinnable). `periods.js` = get/create period (month `YYYY-MM` / quarter
  `YYYY-Qn`), coverage, overview, `previewLock`/`lockPeriod` (immutable versioned snapshot; content hash is
  over the FROZEN RECORD SET, NOT asOf, so re-preview is stable and a late record → genuine v2 with
  `previous_snapshot_id`). `packages.js` = tax data package (revenue by channel + threshold split, each line
  source-indexed). `exports.js` = deterministic CSV artifact + `accounting_exports` row + regenerate-and-
  verify-hash download. Routes in `server/f3/router.js` under `/v1/merchants/:mid/{accounting/*,tax-data/*}`
  (F15 aliases `getAcctSnapshot`/`listAcctSnapshots`/`createAcctExport` to avoid the F13 snapshot/export clash).
- **Functional 15 client (`src/taxbooks/`):** `TaxBooksPage.tsx` (route `/so-sach` — period chips, coverage
  hero, revenue, 5 book cards, lock CTA, snapshot list, sync), `TaxBookLedger.tsx` (`/so-sach/so/:bookCode`),
  `TaxLockPreview.tsx` (`/so-sach/khoa`, immersive `.form-foot` — preview + responsibility + lock),
  `TaxPackage.tsx` (`/so-sach/goi/:snapshotId` — snapshot + package lines + disclaimer + CSV export/download).
  Types/methods in `src/lib/api.ts` (`tax*`). Home grid "Sổ sách" tile + Thuế-page entry; reads any member,
  sync/lock/export owner/manager (server enforces).

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
- **F3 stale-payment guard (`createOrder` idempotency is on `client_request_id`):** `createOrder`
  (sales.js) replays the EXISTING order for a known `client_request_id`, ignoring new items, and
  `lockOrder` short-circuits an already-`awaiting_payment` order. So the POS client must NEVER reuse a
  `clientRequestId` across a new bill (SalesFlow persists `{clientRequestId, cart}` in localStorage;
  the old bug reused a stale id → the payment screen showed an old awaiting bill's total). The fix:
  before locking, `SalesFlow.proceedToPayment` probes `GET /v1/merchants/:mid/outstanding-bill`
  (`getOutstandingBill`, cashier-scoped) and, if another awaiting_payment bill exists, shows an explicit
  dialog — [Thanh toán bill đó] (pay it, keep the current cart, mint a fresh id) / [Hủy bill đó & tiếp
  tục] (`cancelOrder` the stale one, then lock the current cart under a FRESH id). Pure decision helpers
  in `src/lib/checkout.ts` (`proceedDecision`/`canLockCreated`, unit-tested); `lockCurrentCart` never
  locks a non-draft createOrder result. Live regression: `test/fix-stale-payment-e2e.mjs`
  (+ `-setup.mjs`, `soho-crew-test+fix1@soho.test`) — not in `npm test` (`.mjs`, needs DB).
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
  `/ton-kho/doi-chieu`) keep the nav. Same rule for F06: `/nhap-hang/:id` (editor/detail) is immersive;
  `/nhap-hang` (list) keeps the nav.
- **F6 schema quirks (deployed, don't re-derive):** `purchase_receipts` has **NO `note` column** (spec
  3.3 lists one; the migration dropped it — omit note). `received_at` is a `date`; node-pg returns it as
  a Date at LOCAL midnight, so return `to_char`/local-components as `YYYY-MM-DD` (`dateOnly` in
  `receipts.js`), never `toISOString()` (TZ-shifts the day). `suppliers` is name/phone/note only (unique
  `(merchant_id, name)`, NO tax_code). `accounting_events` unique is `(source_type, source_id,
  event_type)` and `review_status ∈ {pending,reviewed,rejected}` (F07/F08 consume these). There are NO
  F6 DB functions — all txns run in Node via the pooler (F3/F4/F5 pattern).
- **F6 storage:** the private `documents` bucket + its merchant-scoped `storage.objects` RLS policy are
  provisioned idempotently over the pooler (`ensureDocumentsBucket` in `server/f6/storage.js`); byte
  upload/download/sign go through the Storage REST API with the **caller's JWT** (path prefix
  `<merchant_id>/…` → the policy is the tenant guard), so no service_role secret is needed. Dedupe is by
  `content_hash`; an exact-hash or matching-`document_number` hit → 409 `POSSIBLE_DUPLICATE_DOCUMENT`
  with candidate receipts (owner/manager may `force`). Extraction failure returns a `status:'failed'`
  marker (document kept) — never throws away the upload (REC-FR-12).
- **F6 movement/idempotency:** each line posts a `purchase_receipt` movement with
  `reference_type='purchase_receipt'`, `reference_id=receipt_id`, `source_line_id=item_id` — the
  `(product_id, movement_type, reference_type, reference_id)` unique index means a receipt must have at
  most ONE line per product (`putItems` rejects duplicate products). Post/reverse take an
  `Idempotency-Key` (in-process single-flight); a posted-receipt replay rebuilds the same result.
- **F6 live E2E:** `F6_BASE=http://localhost:<port> node --env-file=.env test/f6-e2e.mjs` (server
  running with `.env` + a non-3000 `PORT`) runs the spec 12.3 P0 matrix (draft-no-stock, server
  totals, post = N movements + 1 event, idempotent replay, dup-doc warn, RLS cross-tenant, reverse +
  reverse-negative block, reconciliation clean) on `soho-crew-test+f6@soho.test` (+ `+f6b` for RLS)
  via `test/f6-setup.mjs` `ensureF6`. Not in `npm test` (`.mjs`, needs DB). NB: the pooler holds a
  txn open for a whole handler, so a killed server / abandoned fetch can leave an `idle in transaction`
  backend holding a row lock — a test artifact, not a bug (terminate it or restart the pooler).
  `/ton-kho/doi-chieu`) keep the nav.
- **F7 schema quirks (deployed, don't re-derive):** `public.expenses` has a NOT-NULL `created_by` and
  a partial unique `expenses_source_uq (merchant_id, source_type, source_id) WHERE source_id IS NOT NULL`
  (F06-source dedup; manual expenses have NULL source_id and are exempt) — but **NO `note` column**
  (spec's note field has nowhere to persist; omitted). `accounting_events.review_status ∈ {pending,
  reviewed,rejected}`, unique `(source_type,source_id,event_type)` (dedups post/reverse events).
  `expense_categories (merchant_id,code)` unique treats NULL merchant_id rows as DISTINCT, so the GLOBAL
  seed uses `INSERT … WHERE NOT EXISTS`, not ON CONFLICT (`server/f7/categories.js`). RLS on all F7 tables
  is member-**read-only** (`private.has_merchant_role(mid,NULL)`); every write goes through the pooler
  (F3 pattern). Storage bucket `documents` is private.
- **F7 read-after-write must happen AFTER commit.** `getExpense` opens a fresh pool connection, so calling
  it inside the same uncommitted `withTransaction` returns EXPENSE_NOT_FOUND — `createDraft`/`updateDraft`
  return the id from the tx, then fetch. pg returns `date` columns as a JS Date at LOCAL midnight; use
  `isoDate()` (local components), never `String(date).slice` (gives "Sun Aug 16") or `toISOString` (tz shift).
- **F7 duplicate flow:** post detects candidates (posted, same grand_total, date±1, payee-Jaccard≥0.5 / same
  doc hash) and 409s `POSSIBLE_DUPLICATE_EXPENSE` with `details.candidates` unless the body carries
  `duplicateReview.status='NOT_DUPLICATE'`; acknowledging posts AND records `expense_duplicate_findings`
  (open). The 409 clears the in-process idem entry, so a fresh Idempotency-Key on the ack retry is fine.
- **F7 photo path (pilot cut):** `ai/preview` extracts via Gemini and persists a `source_documents`
  metadata row (content hash → dedup/provenance) but does **NOT upload image bytes** to storage (server has
  no service_role / storage write). "View original image" is therefore not wired; extraction + fallback +
  document linkage work. Recurring/định-kỳ expenses are also out (not built).
- **F7 live E2E:** `F7_BASE=http://localhost:<port> node --env-file=.env test/f7-e2e.mjs` (server up with
  `.env` + a non-3000 `PORT`) runs the spec 12.3 P0 matrix (draft/totals/post/rollback/retry/source-dedup/
  duplicate/reverse/double-reverse/RLS) on `soho-crew-test+f7@soho.test` (`test/f7-setup.mjs`
  `ensureF7Merchant`, never a real merchant). Tests reuse the merchant, so non-dup post tests use unique
  amounts / ack duplicates to stay stable across runs. Not in `npm test` (`.mjs`, needs DB).
- **F8 schema is MERGED + MINIMAL (deployed, don't re-derive):** `source_documents` carries BOTH F6
  cols (`object_key`, `content_hash` NOT NULL, `perceptual_hash`, `document_number`, `captured_at`,
  `retention_status`) and F8 cols (`status` default `'ready'`, `mime_type`, `byte_size`, `sha256`,
  `document_type`, `active_extraction_id`, `retain_until`, `legal_hold`, `row_version`, `created_by`
  nullable, `finalized_at`). There are **NO CHECK constraints** (status/link_type are free text — enforce
  in `server/f8/types.js`), **NO unique index on the hash** (dedupe is a query on `(merchant_id,
  content_hash)`, the only index), and **NO DB helper fns / RLS-bypass helpers** (pooler + Node
  `requireMembership`, exactly like F3/F5). Write `content_hash` AND `sha256` to the SAME server hash;
  read either. `document_extractions` is F6-shape (`extractor_version`, `payload`) — unused by F8 MVP.
- **F8 storage bucket `documents` (private) is the hard limit:** `allowed_mime_types` = image/jpeg|png|
  webp ONLY (**PDF is blocked by the bucket** — spec lists PDF but it can't be uploaded here without a
  migration; MVP is image-only), `file_size_limit` = 10 MB. Storage RLS requires the object key's FIRST
  path segment to be a merchant the caller is an active member of → keys are ALWAYS
  `${merchantId}/${uuid}.${ext}`. The server has no service key: it uploads / signs / removes via a
  Supabase client on the caller's JWT (`server/f8/storage.js`). Upload POST needs a 20 MB body cap
  (base64), added as a `readBody` arg in `server/f3/router.js`.
- **F8 links integrate F6/F7 by read-time UNION, not back-fill:** `resolveLinks` UNIONs `document_links`
  with `expenses.document_id` + `purchase_receipts.document_id` back-refs (both tables carry a
  `document_id`) so their docs show as linked automatically; auto back-refs are `primary`/`source:auto`
  and NOT removable from F8 (that would edit the owning record). Only `order` deep-links to a live page
  (`/don-hang/:id`); `expense`/`purchase_receipt` routes resolve once F6/F7 land. Purge is OUT of MVP.
- **F8 `/chung-tu/:id` (detail) is `immersive` in `AppShell.tsx`**; the list `/chung-tu` keeps the nav.
- **F8 live E2E:** `F8_BASE=http://localhost:<port> node --env-file=.env test/f8-e2e.mjs` (server running
  with `.env` + a non-3000 `PORT`) runs upload/hash/dedupe+override/idempotency/MIME-gate/signed-URL+
  access-audit/link+unlink/target-verify/expense-backref/archive+restore/RLS-cross-tenant on
  `soho-crew-test+f8@soho.test` (`test/f8-setup.mjs`, never a real merchant). Not in `npm test`.
- **F9 has NO signed e-invoice provider** (founder: not signed yet). Everything runs against the
  **MockProvider** in `server/f9/provider.js` behind the `EInvoiceProvider` interface; a real provider
  later is ONE new adapter (`registerProvider`) + secret, zero app changes. UI is labelled honestly
  ("Nhà cung cấp thử nghiệm — chưa nối cơ quan thuế"); `accepted` shows "Đã phát hành" ONLY after a
  verified event, never on HTTP 2xx. `EINVOICE_MOCK_SECRET` (server-only) signs webhooks; a real webhook
  can't reach a laptop, so the **dev-only** `POST /v1/dev/e-invoice/simulate` (guarded by
  `SOHO_DEV_ENDPOINTS=1`) drives accept/reject through the SAME signed event path.
- **F9 tax model is tax-INCLUSIVE** (`server/f9/totals.js`): order line net = amount paid; tax is
  extracted OUT of it so invoice total == bill total exactly (reconciles with F03). Do not re-gross.
  Tax code/rate come ONLY from the versioned `mapping.js` table (`RULE_SET_VERSION` stamped per invoice),
  never AI/client. Negative/edit of an accepted invoice is impossible — correction is a linked
  adjustment/replacement draft (`e_invoice_relations`); the original flips to adjusted/replaced when the
  child is accepted.
- **F9 schema quirks (VERIFIED live, don't re-derive):** `e_invoices` has `profile_id` (NULLABLE, no FK →
  set to `deterministicUuid('einvoice-profile:'+merchantId)`), `invoice_kind` DEFAULT **`'original'`** (NOT
  'sale'), `created_by` NOT NULL, `rule_set_version` default `'VN-2026.1'` (F9 overrides with its own
  `RULE_SET_VERSION`). **`e_invoice_items` AND `e_invoice_submissions` each carry a NOT-NULL `merchant_id`**
  (easy to miss — the inserts MUST include it). `e_invoice_provider_events` has NO merchant_id + NOT-NULL
  `payload_hash`. There is NO `e_invoice_profiles` table (seller snapshot reads `merchants`). Corrective
  invoices use `invoice_kind = adjustment|replacement` so the partial-unique `(merchant_id, order_id,
  invoice_kind) WHERE status NOT IN ('rejected','cancelled')` never clashes with the accepted `original`.
  Artifacts are server-generated placeholders from the accepted snapshot (NOT stored in F08's
  `source_documents` box — a documented MVP boundary).
- **F9 live E2E:** `PORT=<p> SOHO_DEV_ENDPOINTS=1 node --env-file=.env server/index.js &` then
  `F9_BASE=http://localhost:<p> node --env-file=.env test/f9-e2e.mjs` (spec 12.3 P0: eligibility, one-
  original concurrency, totals, buyer MST, submit idempotency, webhook bad-sig + duplicate, artifacts,
  relation, rejected retry, RLS) on `soho-crew-test+f9@soho.test` (`test/f9-setup.mjs ensureF9Merchant`,
  seller MST seeded so readiness passes). Not in `npm test` (`.mjs`, needs DB). **Verified LIVE green:
  27/27 on the real DB + a browser walkthrough (Home tile → list badges → accepted detail with XML/PDF
  artifacts + relation → rejected detail with retry).**
- **F11 schema quirks (deployed, don't re-derive):** `cashbook_adjustments` has a SINGLE
  `adjustment_entry_id` + `reason` text (NOT the spec §8.4 reversal/replacement/reason_code/note split);
  unique `cashbook_one_reversal (merchant_id, original_entry_id)` = the one-reversal guard.
  `cashbook_period_snapshots` does NOT exist → summary + coverage are computed LIVE per period (no
  snapshot rows). `cashbook_entries.entry_type` is free text (no CHECK) — the taxonomy allowlist lives
  in `server/f11/mapping.js` `ENTRY_TYPES` (sales_receipt/other_receipt/sales_refund/operating_expense/
  inventory_purchase/adjustment). `cashbook_entries.created_by` is NOT NULL FK auth.users, so auto-posts
  use the merchant OWNER as the system actor (`resolveSystemActor`). Clients have NO write grants — ALL
  cashbook access is server-only via the pooler (F3 pattern); no RLS is relied upon.
- **F11 reversal model (spec §7.1 "không update giá trị bản gốc"):** the original entry is NEVER mutated
  (status stays `posted`); a reversal only appends an opposite-direction `posted` `adjustment` entry (same
  amount + occurred_at) + one `cashbook_adjustments` row. **Totals = `status='posted'` ONLY** (uses the
  `cashbook_entry_period` partial index); the reversed original + its contra both count and net to zero —
  do NOT flip the original to `reversed` or the offset math breaks (the `adjustment_entry_id` NOT NULL FK
  also forces a contra to exist). "Reversed" is a DERIVED display state (an adjustment row references the
  entry as `original_entry_id`).
- **F11 mapping decisions (founder-pending, spec §13.2):** payment.succeeded → auto-post in/sales_receipt
  (method cash→cash, qr→transfer); refund.succeeded → auto-post out/sales_refund; purchase_received &
  expense_posted accounting_events → ALWAYS review (accounting_events carries no payment_method, and a
  purchase ≠ cash-paid), reason `needs_payment_confirmation`/`missing_payment_method`. F07 expense &
  F09/F06 purchase auto-posting is one MAPPINGS edit away once those events carry a method. source_type
  in links = payment|refund|purchase_receipt|expense|manual (source_id = the row id; deep-link resolved
  live: payment/refund→/don-hang/:orderId, purchase_receipt→/nhap-hang/:receiptId).
- **F11 ingest paths:** (1) in-process post-commit hooks in F3 `finalizeCash`/`confirmQrPayment`/
  `confirmRefund`/`createReturn` (`bestEffortIngest` — swallows errors, never blocks a sale); (2) the
  on-demand `POST /cashbook/sync` scan (owner/manager) that fills gaps for events fired before this
  feature or by other lanes. Both are idempotent (source-link + review unique). Backfilling the two REAL
  merchants' ~870 bills each = call `syncMerchant` per merchant (NOT done — left ready; never mutate
  their source rows).
- **F11 live E2E:** `PORT=3011 SOHO_DEV_ENDPOINTS=1 node --env-file=.env server/index.js &` then
  `F11_BASE=http://localhost:3011 node --env-file=.env test/f11-e2e.mjs` runs the spec 12.3 P0 matrix
  (replay/sync idempotency, mapping, hand-computed totals + timezone, review resolve→atomic post, reverse
  + one-reversal guard + offset, manual draft, RLS cross-tenant, real-sale post-commit hook, immutability)
  on `soho-crew-test+f11@soho.test` (+ `+f11b` for RLS) via `test/f11-setup.mjs` `ensureF11` (seeds
  SYNTHETIC source rows — order+payment+refund+accounting_event — into the test tenant only). Not in
  `npm test` (`.mjs`, needs DB).
- **F12 schema quirks (deployed, don't re-derive):** `reconciliation_candidates` does NOT exist (candidate
  matching is out of MVP — the 4 tables are runs/issues/evidence/resolution_attempts). `reconciliation_runs.
  status ∈ {running,completed,failed}` (partial coverage = 'completed' with per-rule errors in `counters`);
  `reconciliation_issues.status ∈ {detected,in_review,action_pending,resolved,dismissed,failed}` with the
  partial unique `recon_one_active_fingerprint (merchant_id,fingerprint) WHERE status in (detected,in_review,
  action_pending,failed)` (the concurrency + dedup guard). `reconciliation_issues.run_id` FK has NO cascade
  → delete issues BEFORE runs. Evidence is insert-only (revoke update/delete); `source_id` is a NOT-NULL uuid
  so every rule keys on a single uuid entity. There are NO F12 DB functions — all runs are Node txns.
- **F12 detection semantics:** a rule fires at most ONE issue per entity; rules are mutually exclusive by
  construction (e.g. ORDER_PAID_NO_PAYMENT needs 0 captured, ORDER_PAYMENT_TOTAL_MISMATCH needs >0). Dismiss
  is permanent suppression (NO expiry column in MVP). Auto-resolve only closes issues whose rule ran WITHOUT
  error this run (a rule error → coverage incomplete → its issues are NOT resolved). MVP does NOT execute
  owner commands — `requestAction` records the intent + flips to action_pending; the fix happens in the
  owner's native flow and the NEXT run verifies-and-closes.
- **F12 live E2E:** `PORT=<non-3000> SOHO_DEV_ENDPOINTS=1 node --env-file=.env server/index.js &` then
  `F12_BASE=http://localhost:<port> node --env-file=.env test/f12-e2e.mjs` runs the spec 12.3 P0 matrix
  (detection+impact, fingerprint dedup, run idempotency, evidence immutability, dismiss gate+suppression,
  transitions, verify-before-close, RLS cross-tenant, dry-run no-write) on `soho-crew-test+f12@soho.test`
  (+ `+f12b` for RLS) via `test/f12-setup.mjs` (seeds SYNTHETIC mismatches into the test tenant only).
  `test/f12-dryrun-real.mjs` runs read-only detection over the 2 REAL merchants (logs findings, writes
  nothing). Neither is in `npm test` (`.mjs`, needs DB). The e2e is subset-based (assumes accumulated seeds),
  so it never asserts absolute issue totals.
- **F13 schema is deployed + code is the formula catalog (don't re-derive):** `report_snapshots` (build key
  unique `(merchant_id,period_start,period_end,timezone,scope_hash,formula_version,as_of,revision)`; `created_by`
  NOT NULL; formula_version default `VN-2026.1`), `report_snapshot_metrics` (+ `merchant_id`; unique
  `(snapshot_id,metric_code,dimensions_hash)`; scalar rows use the empty-dims hash; `value_vnd`|`value_count`;
  `source_ref_set_id` **nullable** → left null, drill-down resolves live bounded by the snapshot), `report_data_quality`
  (+ `merchant_id`; free-text `status`, enforce in code), `report_exports` uses **`export_type`/`storage_path`**
  (NO format/content_hash/expires_at/export_scope cols). **`report_formula_catalog` does NOT exist** — the catalog
  lives in `server/f13/catalog.js`. Status values used: building/ready/failed/superseded. RLS is ON but reports go
  through the pooler (like F3–F8); the Node `requireMembership(owner|manager)` is the tenant guard.
- **F13 CSV export is streamed, not stored (pilot cut):** the `documents` bucket is image-mime-only, so CSV can't
  be uploaded there without a migration. `POST …/exports` records a `report_exports` audit row and `GET
  …/exports/:eid/download` REGENERATES the CSV from the immutable snapshot (parity + hash stability by
  construction) and streams it (BOM + `Content-Disposition`). PDF and signed-URL object storage are post-pilot.
- **F13 estimate = net revenue − posted operating expenses** (founder decision); inventory purchases (F06) are
  shown SEPARATELY and NOT subtracted; damage (F05 `damage_writeoff`) is count+qty only (no COGS/value). Coverage
  is first-class: bills-without-line-items make `sales_top_products`/`order_items` partial|unavailable, NEVER 0.
  Both real merchants have ~856 paid bills with 0 line items → top-products is `unavailable` there (expected).
- **F13 live E2E:** `node --env-file=.env test/f13-e2e.mjs` (needs DB + Supabase auth; NOT in `npm test`) seeds a
  deterministic today on `soho-crew-test+f13@soho.test`, then checks hand-computed metrics, **same-day snapshot ==
  `get_today_dashboard`**, coverage gap, immutable rebuild→revision, drill-down sum parity, compat compare, CSV
  parity and cross-tenant block. Pure logic is unit-tested in `test/f13-reports.test.js` (in `npm test`).
- **F14 schema quirks (deployed, don't re-derive):** NO `locations` table → `daily_closings` is unique
  `(merchant_id, business_date)` (single-location MVP, no location_id anywhere). NO `closing_previews`
  table and NO DB functions → the preview is built in-memory and bound by a `preview_hash` the confirm
  echoes. NO `cash_count_lines` table → denomination lines live in `cash_counts.denomination_lines`
  jsonb. NO immutability trigger on `closing_revisions` (verified) → a confirmed revision is immutable
  by APPLICATION rule only (there is NO update/delete endpoint; fixes = a new revision), like F11.
  `closing_revisions.variance_vnd` is a GENERATED column; `closing_attention_items.status ∈
  open|resolved|dismissed`, unique `(revision_id, source_fingerprint)`. All F14 access is server-only
  via the pooler (F3 pattern); clients have no write grants.
- **F14 expected cash (MVP cut):** expected = Σ(cash payments succeeded) − Σ(cash refunds succeeded)
  in the business-day window (`server/f14/service.js loadCashSources`, reuses the F2 window math + the
  `payments_dashboard_idx`/`refunds_dashboard_idx` partial indexes → sub-ms). Opening float and F07/F11
  cash movements are OUT of the pilot (documented cut) — add them as more source loaders. QR is
  reference-only, never in the drawer. cut_off is server now(); a source is "late" by set-difference
  (a cash source in the window not in ANY draft snapshot of the closing), NOT by a received_at>cut_off
  scan. Re-close resolves open attention items (`decision='reclosed'`).
- **F14 confirm invariants:** confirm requires `Idempotency-Key` + `previewHash` + `responsibilityConfirmed`.
  It recomputes the live `sourceSetHash` (drift since prepare → 409 CLOSING_SOURCE_CHANGED) and the
  `previewHash` from what it will write (mismatch → 409 CLOSING_PREVIEW_STALE); a non-zero variance
  needs a reason (`other` needs a note → 422). runIdempotent's OUTER replayed flag must be merged into
  the returned result (the cached inner result carries `replayed:false` from the first run).
- **F14 live E2E:** `PORT=3014 SOHO_DEV_ENDPOINTS=1 node --env-file=.env server/index.js &` then
  `F14_BASE=http://localhost:3014 node --env-file=.env test/f14-e2e.mjs` runs the spec 12.3 P0 matrix
  (expected formula + QR-excluded, denomination server-total, balanced/short confirm + reason gate,
  double-tap idempotent, source-drift 409, late-source attention + re-close chain + rev-1 immutability,
  RLS cross-tenant) on `soho-crew-test+f14@soho.test` (+ `+f14b` for RLS) via `test/f14-setup.mjs`
  `ensureF14` + `seedCashDay`/`cleanClosingDay` (SYNTHETIC orders/payments/refunds on fixed past dates,
  test tenant only). Not in `npm test` (`.mjs`, needs DB). NB: cold requests pay ~7s Supabase
  auth+pooler TLS warmup, so run the e2e as a background job (don't cut it off at a short timeout); a
  `pkill -f test/f14-e2e.mjs` self-matches its own shell — kill by pid instead.
- **F15 schema quirks (deployed, don't re-derive):** `accounting_records` has BOTH `book_code` (NOT NULL,
  the real book key F15 uses) AND a nullable `book_definition_id` (left NULL — there is NO
  `catalog_definitions` table, so the book/field/rule catalog lives in `server/f15/mapping.js`, not the DB).
  `amount_vnd` is a SIGNED bigint (refunds/expenses stored negative → a book total is a plain SUM; sổ doanh
  thu nets to F02/F13). `accounting_source_receipts` creation time is **`received_at`** (NOT `created_at` —
  that column is `accounting_records`'). There is **NO** `accounting_period_record_links` table: a snapshot's
  frozen record set is defined by the watermark rule (posted records in [start,end] with
  `created_at <= source_watermark.asOf`); integrity is the record-fingerprint content hash stored in
  `source_watermark`. `accounting_period_snapshots` + `tax_data_package_lines` each carry a NOT-NULL
  `merchant_id` (easy to miss). `accounting_exports` has NO unique index (idempotency = look up existing by
  (merchant, snapshot, object_key) + matching content_hash). All F15 access is server-only via the pooler +
  `requireMembership` (no RLS relied upon). No F15 DB functions — Node txns (F3 pattern).
- **F15 lock semantics:** the preview/snapshot content hash is over the FROZEN RECORD SET (period + rule/
  catalog version + record fingerprint + book totals), deliberately NOT over `asOf` — so re-previewing an
  unchanged period returns the same hash (lock replays the current snapshot, no spurious v2), while a late
  source changes the fingerprint → a genuine restatement v2 (`previous_snapshot_id` chain, v1 immutable).
  A stale/garbage previewHash at lock → 409. Coverage watermark constrains ONLY the processed (receipts
  `received_at`) side, never the expected side. CSV export is stored as an `accounting_exports` row +
  regenerated-and-hash-verified on download (no bucket object / signed URL — a documented pilot cut).
- **F15 live E2E:** `PORT=3015 SOHO_DEV_ENDPOINTS=1 node --env-file=.env server/index.js &` then
  `F15_BASE=http://localhost:3015 node --env-file=.env test/f15-e2e.mjs` runs the spec 12.3 P0 matrix
  (record-build dedupe, sổ doanh thu == payments−refunds parity, book totals, book→source drill, preview/
  lock + replay, stale-hash 409, package 1-tỷ threshold split hand-verified + deterministic, deterministic
  CSV export + BOM, late-source → attention → re-lock v2 chained + v1 immutable, RLS, catalog published) on
  `soho-crew-test+f15@soho.test` (+ `+f15b` for RLS) via `test/f15-setup.mjs` `ensureF15` (seeds SYNTHETIC
  June 900M + July 220c/100qr/−20 sources crossing the threshold). The e2e `cleanup()`s F15 rows on the
  test tenant at start so it is re-runnable. Not in `npm test` (`.mjs`, needs DB). **Verified LIVE green:
  12/12 + browser walkthrough (Thuế → /so-sach → books → v2 snapshot package with exact split → CSV export).**

- **Branding / theme (deployed):** brand anchors are deep navy **`#122560`** and tiffany **`#81D8D0`**
  (CSS tokens `--navy` / `--brand-teal` in `src/index.css`; `--teal #178f86` is the readable deep-tiffany
  accent for text/icons on white; primary buttons + `--ink` are navy). Bottom-nav selected tab = a `#D3D3D3`
  pill with navy label (`.bottomnav__item--on`). Low/out-of-stock is RED `--low #dc2626` (`.inv-row__qty--low/
  --out`, `.pill--low/--out`, `.prod__stock--low/--out`, `.attn__low`) — NOT amber. The official logo lives in
  `public/logo-full.png` (transparent, welcome/auth splash at ~80% opacity via `.brand-logo`) + `logo-mark.png`
  (monogram); PWA icons (`icon-{192,512}[.-maskable].png`, `apple-touch-icon.png`, `favicon-{32,48}.png`,
  `favicon.svg`) are all on the navy square. Regenerate every asset deterministically from the source jpg with
  `python3 scripts/make-brand-assets.py [src.jpg]` (Pillow; removes near-white bg). Bump `CACHE` in
  `public/sw.js` when icons change so installed PWAs re-fetch.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
