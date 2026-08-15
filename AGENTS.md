# Project agent memory

SoHo "Thiết lập cửa hàng" — a mobile-first, Vietnamese, MoMo-style **PWA** for
household businesses. Functional 01: onboarding that creates the store's
operating profile. Functional 02: the "Trang Hôm nay" (Today) dashboard —
read-only daily revenue/attention view (no selling yet). Vite + React + TS SPA
talking **directly to Supabase** from the client, served by a combined Node
server that also hosts the pre-existing PayOS payment API. Specs:
`/home/nguye/firstmate/data/soho-onboarding-app/soho-functional-01.md`,
`/home/nguye/firstmate/data/soho-today-dashboard/soho-functional-02.md`.

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
  adapted file (serves `dist/` with SPA deep-link fallback; PayOS routes + `/health` unchanged).

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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
