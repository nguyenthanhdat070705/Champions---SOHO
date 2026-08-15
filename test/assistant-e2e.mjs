// Live end-to-end verification for the AI Assistant (Functional 10). NOT part of
// `npm test` (needs the live DB + Gemini + a running server). Run:
//   PORT=3000 node --env-file=.env server/index.js &
//   node --env-file=.env test/assistant-e2e.mjs
// Operates ONLY on its own throwaway merchant (soho-crew-test+ai@soho.test); it
// never mutates the two real seeded merchants. Verifies: grounded numeric answers,
// source cards, honest out-of-data answer, cross-tenant isolation (403), and the
// Gemini-down fallback (a second server started with an invalid key).
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildFacts } from "../server/assistant/facts.js";
import { formatVnd } from "../server/f3/format.js";

const BASE = process.env.AI_BASE || "http://localhost:3000";
const URL = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_ANON_KEY;
const EMAIL_A = "soho-crew-test+ai@soho.test";
const PASSWORD_A = "SohoAiTest!2026";
const EMAIL_B = "soho-crew-test+f3@soho.test"; // an EXISTING second tenant
const PASSWORD_B = "SohoF3Test!2026";
const REAL_MERCHANTS = ["4e63a397-e811-48b1-86e5-d7fc5ffa9f0e", "830effcb-2d6b-4e99-9b0f-07471755e60d"];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
// The Supabase session pooler occasionally resets a fresh connection; retry a
// couple of times so verification isn't flaky on transient ECONNRESET.
async function pquery(t, p) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await pool.query(t, p); }
    catch (e) {
      last = e;
      if (!["ECONNRESET", "ETIMEDOUT", "57P01"].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last;
}
const sql = (t, p) => pquery(t, p);
const query = (t, p) => pquery(t, p);

let PASS = 0, FAIL = 0;
const log = (...a) => console.log(...a);
function ok(name, cond, extra = "") { if (cond) { PASS++; log(`  ✅ ${name}${extra ? " — " + extra : ""}`); } else { FAIL++; log(`  ❌ ${name}${extra ? " — " + extra : ""}`); } }
function section(t) { log(`\n=== ${t} ===`); }

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

async function signIn(email, password) {
  let r = await sb.auth.signInWithPassword({ email, password });
  if (r.error) {
    await sb.auth.signUp({ email, password });
    r = await sb.auth.signInWithPassword({ email, password });
  }
  if (r.error) throw new Error(`signin ${email}: ${r.error.message}`);
  return r.data.session;
}

async function api(method, path, { body, idem, token, base = BASE } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function ensureMerchant(session) {
  const uid = session.user.id;
  const m = await sql(`select merchant_id from public.merchant_members where user_id=$1 and status='active' order by created_at limit 1`, [uid]);
  if (m.rows.length) return m.rows[0].merchant_id;
  // Create a merchant for this test account via the onboarding RPC (authenticated).
  const authed = createClient(URL, KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${session.access_token}` } } });
  const { data, error } = await authed.rpc("create_merchant_onboarding", {
    p_display_name: "Tạp hóa Trợ Lý Test",
    p_legal_name: "",
    p_tax_code: "",
    p_business_model: "retail",
    p_registration_status: "unknown",
    p_filing_frequency: "unknown",
    p_idempotency_key: randomUUID(),
  });
  if (error) throw new Error("create merchant: " + error.message);
  return data;
}

async function cleanMerchant(mid) {
  // Delete ONLY this test merchant's transactional rows, FK-safe order.
  await sql(`delete from public.payment_refunds where merchant_id=$1`, [mid]);
  await sql(`delete from public.inventory_movements where merchant_id=$1`, [mid]);
  await sql(`delete from public.payments where merchant_id=$1`, [mid]);
  await sql(`delete from public.order_adjustments where merchant_id=$1`, [mid]);
  await sql(`delete from public.order_items where merchant_id=$1`, [mid]);
  await sql(`delete from public.orders where merchant_id=$1`, [mid]);
  await sql(`delete from public.inventory_levels where merchant_id=$1`, [mid]);
  await sql(`delete from public.products where merchant_id=$1`, [mid]);
}

async function chat(text, { token, mid, base } = {}) {
  return api("POST", "/v1/assistant/chat", { token, base, body: { merchantId: mid, messages: [{ role: "user", content: text }] } });
}

function waitForHealth(base, ms = 15000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(base + "/health");
        if (r.ok) return resolve(true);
      } catch { /* not up yet */ }
      if (Date.now() > deadline) return reject(new Error("server not healthy: " + base));
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function main() {
  section("Setup: sign in + own throwaway merchant");
  const sessA = await signIn(EMAIL_A, PASSWORD_A);
  const tokenA = sessA.access_token;
  const MID_A = await ensureMerchant(sessA);
  log(`Tenant A: ${EMAIL_A}  merchant=${MID_A}`);
  if (REAL_MERCHANTS.includes(MID_A)) throw new Error("REFUSING: test merchant A resolved to a REAL merchant id");

  await cleanMerchant(MID_A);
  const mk = async (name, price, stock) => {
    const r = await api("POST", `/v1/merchants/${MID_A}/products/quick`, { token: tokenA, idem: randomUUID(), body: { name, salePrice: price, unitCode: "item", trackInventory: true, initialStock: stock, lowStockThreshold: 2 } });
    if (r.status !== 201) throw new Error("quick-create: " + JSON.stringify(r.json));
    return r.json.product;
  };
  const water = await mk("Nước suối 500ml", 10000, 20);
  const cake = await mk("Bánh ngọt", 15000, 1); // below threshold(2) after a sale → low stock
  const coffee = await mk("Cà phê", 25000, 20);

  const sell = async (items) => {
    const o = await api("POST", `/v1/merchants/${MID_A}/orders`, { token: tokenA, body: { clientRequestId: randomUUID(), items } });
    if (o.status !== 201) throw new Error("order: " + JSON.stringify(o.json));
    const ord = o.json.order;
    const p = await api("POST", "/v1/payments/cash", { token: tokenA, idem: randomUUID(), body: { merchantId: MID_A, orderId: ord.id, expectedVersion: ord.version, cashReceived: ord.totalAmount } });
    if (p.status !== 200) throw new Error("cash: " + JSON.stringify(p.json));
    return ord.totalAmount;
  };
  const t1 = await sell([{ productId: water.id, quantity: 2 }, { productId: coffee.id, quantity: 1 }]); // 45.000
  const t2 = await sell([{ productId: cake.id, quantity: 1 }]); // 15.000 → cake stock 0
  const t3 = await sell([{ productId: coffee.id, quantity: 2 }]); // 50.000
  log(`Created 3 cash bills: ${formatVnd(t1)}, ${formatVnd(t2)}, ${formatVnd(t3)}`);

  // Ground-truth from the same builder the server uses.
  const facts = await buildFacts(query, MID_A);
  const netStr = formatVnd(facts.today.net);
  log(`DB facts → net=${netStr} gross=${formatVnd(facts.today.gross)} bills=${facts.today.paidOrderCount} cashNet=${formatVnd(facts.today.cashNet)} lowStock=${facts.today.lowStockCount}`);

  section("AST-01: 'Hôm nay bán được bao nhiêu?' — grounded number + source card");
  {
    const r = await chat("Hôm nay bán được bao nhiêu?", { token: tokenA, mid: MID_A });
    ok("200", r.status === 200, `mode=${r.json?.mode}`);
    ok("reply cites today's net exactly", (r.json?.reply || "").includes(netStr), `expected "${netStr}" in: ${JSON.stringify(r.json?.reply)}`);
    ok("has a source card to Trang Hôm nay (/)", (r.json?.sources || []).some((s) => s.route === "/"), JSON.stringify(r.json?.sources));
    ok("kind=answer", r.json?.kind === "answer");
  }

  section("AST-02: 'Món nào sắp hết hàng?' — low-stock grounded + Kho source");
  {
    const r = await chat("Món nào sắp hết hàng?", { token: tokenA, mid: MID_A });
    ok("200", r.status === 200, `mode=${r.json?.mode}`);
    ok("mentions the out-of-stock product", /Bánh ngọt/i.test(r.json?.reply || ""), JSON.stringify(r.json?.reply));
    ok("source card → /kho", (r.json?.sources || []).some((s) => s.route === "/kho"));
  }

  section("AST-03: week comparison — grounded, Báo cáo source");
  {
    const r = await chat("Tuần này so với tuần trước thế nào?", { token: tokenA, mid: MID_A });
    const w = formatVnd(facts.week.last7Net);
    ok("200", r.status === 200, `mode=${r.json?.mode}`);
    ok("cites 7-day total", (r.json?.reply || "").includes(w), `expected ${w} in: ${JSON.stringify(r.json?.reply)}`);
  }

  section("AST-04: out-of-data question → honest 'chưa đủ dữ liệu' (no invented number)");
  {
    const r = await chat("Lợi nhuận tháng này của tôi là bao nhiêu?", { token: tokenA, mid: MID_A });
    const reply = r.json?.reply || "";
    ok("200", r.status === 200, `mode=${r.json?.mode}`);
    ok("honest hedge", /chưa đủ|không đủ|chưa có|thiếu/i.test(reply), JSON.stringify(reply));
  }

  section("RLS: tenant B cannot read tenant A's numbers (membership guard)");
  {
    const sessB = await signIn(EMAIL_B, PASSWORD_B);
    const midB = (await sql(`select merchant_id from public.merchant_members where user_id=$1 and status='active' order by created_at limit 1`, [sessB.user.id])).rows[0]?.merchant_id;
    const r1 = await chat("Hôm nay bán được bao nhiêu?", { token: sessB.access_token, mid: MID_A });
    ok("B→A merchant is FORBIDDEN", r1.status === 403 && r1.json?.code === "FORBIDDEN", `${r1.status} ${r1.json?.code}`);
    if (midB && !REAL_MERCHANTS.includes(midB)) {
      const r2 = await chat("Hôm nay bán được bao nhiêu?", { token: tokenA, mid: midB });
      ok("A→B merchant is FORBIDDEN", r2.status === 403 && r2.json?.code === "FORBIDDEN", `${r2.status} ${r2.json?.code}`);
    }
    // No-token request is rejected too.
    const r3 = await chat("Hôm nay bán được bao nhiêu?", { token: null, mid: MID_A });
    ok("missing token → 401", r3.status === 401, `${r3.status}`);
  }

  section("AI-DOWN: invalid Gemini key → deterministic fallback still answers, grounded");
  {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing — run the e2e with --env-file=.env");
    const child = spawn(process.execPath, ["server/index.js"], {
      // Explicit env: keep DATABASE_URL/Supabase, but force an INVALID Gemini key
      // so every AI call fails and the server must serve the deterministic fallback.
      env: {
        ...process.env,
        PORT: "3301",
        GEMINI_API_KEY: "invalid-key-for-fallback-test",
        NODE_ENV: "development",
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    try {
      await waitForHealth("http://localhost:3301");
      const r = await chat("Hôm nay bán được bao nhiêu?", { token: tokenA, mid: MID_A, base: "http://localhost:3301" });
      ok("200 even with AI down", r.status === 200, `mode=${r.json?.mode}`);
      ok("mode=fallback", r.json?.mode === "fallback", `mode=${r.json?.mode}`);
      ok("fallback still cites today's net", (r.json?.reply || "").includes(netStr), JSON.stringify(r.json?.reply));
      ok("fallback still has source card", (r.json?.sources || []).length >= 1);
    } finally {
      child.kill("SIGKILL");
    }
  }

  section(`RESULT: ${PASS} passed, ${FAIL} failed`);
  await pool.end();
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { log("FATAL", e); process.exit(2); });
