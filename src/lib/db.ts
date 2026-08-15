// All Supabase data access for onboarding + dashboard. RLS on the project
// enforces that a user only ever reads/writes their own rows and their own
// merchant's rows; these helpers set the owning ids explicitly to satisfy the
// insert/update WITH CHECK policies.
import { supabase } from "./supabase";
import { CONSENT_DOCUMENT_VERSION } from "./config";
import type { OnboardingData } from "./types";
import type {
  BusinessModel,
  FilingFrequency,
  RegistrationStatus,
} from "./enums";
import { normalizeTaxCode } from "./validators";
import type { DashboardSnapshot, OpenAction } from "./dashboard";

// ── Consents (append-only log; inserted right after first auth) ──────────────
export async function insertConsents(
  userId: string,
  choices: OnboardingData["consents"],
): Promise<void> {
  const now = new Date().toISOString();
  const rows = [
    { consent_type: "terms", granted: true },
    { consent_type: "privacy", granted: true },
    { consent_type: "marketing", granted: choices.marketing },
  ].map((r) => ({
    user_id: userId,
    consent_type: r.consent_type,
    document_version: CONSENT_DOCUMENT_VERSION,
    granted: r.granted,
    granted_at: r.granted ? now : null,
    user_agent:
      typeof navigator !== "undefined"
        ? navigator.userAgent.slice(0, 300)
        : null,
  }));
  const { error } = await supabase.from("consents").insert(rows);
  if (error) throw new Error(error.message);
}

// ── Profile ──────────────────────────────────────────────────────────────────
export async function updateProfileName(
  userId: string,
  fullName: string,
  email?: string | null,
): Promise<void> {
  const patch: Record<string, unknown> = { full_name: fullName.trim() };
  if (email) patch.email = email.trim().toLowerCase();
  const { error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

// ── Onboarding progress (draft / resume) ─────────────────────────────────────
export interface OnboardingRow {
  id: string;
  user_id: string;
  merchant_id: string | null;
  current_step: number;
  completed_steps: number[];
  draft_data: Partial<OnboardingData> | null;
  status: "in_progress" | "completed" | "abandoned";
  idempotency_key: string;
}

export async function loadLatestOnboarding(
  userId: string,
): Promise<OnboardingRow | null> {
  const { data, error } = await supabase
    .from("onboarding_progress")
    .select(
      "id, user_id, merchant_id, current_step, completed_steps, draft_data, status, idempotency_key",
    )
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as OnboardingRow | null) ?? null;
}

export async function saveDraft(params: {
  userId: string;
  idempotencyKey: string;
  currentStep: number;
  completedSteps: number[];
  draftData: OnboardingData;
}): Promise<void> {
  // draft_data must never contain passwords or full account numbers — the
  // OnboardingData shape only ever holds the masked account form.
  const { error } = await supabase.from("onboarding_progress").upsert(
    {
      user_id: params.userId,
      idempotency_key: params.idempotencyKey,
      current_step: params.currentStep,
      completed_steps: params.completedSteps,
      draft_data: params.draftData,
      status: "in_progress",
    },
    { onConflict: "user_id,idempotency_key" },
  );
  if (error) throw new Error(error.message);
}

// ── Finish: atomic + idempotent merchant creation via RPC ───────────────────
export async function createMerchantOnboarding(params: {
  displayName: string;
  legalName: string;
  taxCode: string;
  businessModel: BusinessModel;
  registrationStatus: RegistrationStatus;
  filingFrequency: FilingFrequency;
  idempotencyKey: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("create_merchant_onboarding", {
    p_display_name: params.displayName,
    p_legal_name: params.legalName ?? "",
    p_tax_code: params.taxCode ?? "",
    p_business_model: params.businessModel,
    p_registration_status: params.registrationStatus,
    p_filing_frequency: params.filingFrequency,
    p_idempotency_key: params.idempotencyKey,
  });
  if (error) throw new Error(error.message);
  return data as string; // merchant_id
}

export async function insertAddress(
  merchantId: string,
  a: { addressLine: string; provinceText: string; wardText: string },
): Promise<void> {
  const { error } = await supabase.from("merchant_addresses").insert({
    merchant_id: merchantId,
    address_type: "store",
    address_line: a.addressLine.trim(),
    province_code: a.provinceText.trim() || null,
    ward_code: a.wardText.trim() || null,
    country_code: "VN",
    is_primary: true,
  });
  if (error) throw new Error(error.message);
}

export async function insertPaymentConnection(
  merchantId: string,
  p: { bankCode: string; accountName: string; accountMasked: string },
): Promise<void> {
  const { error } = await supabase.from("payment_connections").insert({
    merchant_id: merchantId,
    provider: "manual_bank",
    bank_code: p.bankCode || null,
    account_name: p.accountName.trim() || null,
    account_masked: p.accountMasked || null, // masked form only, never raw
    qr_mode: "dynamic",
    status: "pending",
    is_default: true,
    metadata: {},
  });
  if (error) throw new Error(error.message);
}

// ── Dashboard reads ──────────────────────────────────────────────────────────
export interface MerchantRow {
  id: string;
  display_name: string;
  legal_name: string | null;
  tax_code_normalized: string | null;
  business_model: BusinessModel;
  status: string;
  onboarding_completed_at: string | null;
}

export interface TaxRow {
  id: string;
  registration_status: RegistrationStatus;
  filing_frequency: FilingFrequency;
  verification_status: "unverified" | "pending" | "verified";
  config_version: string;
  effective_from: string;
}

export interface PaymentRow {
  id: string;
  provider: string;
  bank_code: string | null;
  account_name: string | null;
  account_masked: string | null;
  status: "pending" | "verified" | "failed" | "revoked";
  is_default: boolean;
}

/** Returns the merchant the current user owns/manages, or null if none yet. */
export async function loadMyMerchant(userId: string): Promise<MerchantRow | null> {
  const { data, error } = await supabase
    .from("merchant_members")
    .select(
      "merchant_id, merchants(id, display_name, legal_name, tax_code_normalized, business_model, status, onboarding_completed_at)",
    )
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const m = (data as { merchants: MerchantRow | MerchantRow[] | null }).merchants;
  const merchant = Array.isArray(m) ? m[0] : m;
  return merchant ?? null;
}

/** The current user's role in a merchant ('owner'|'manager'|'cashier'), for UI gating. */
export async function loadMyRole(userId: string, merchantId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("merchant_members")
    .select("role")
    .eq("user_id", userId)
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { role: string } | null)?.role ?? null;
}

export async function loadTaxProfile(merchantId: string): Promise<TaxRow | null> {
  const { data, error } = await supabase
    .from("merchant_tax_profiles")
    .select(
      "id, registration_status, filing_frequency, verification_status, config_version, effective_from",
    )
    .eq("merchant_id", merchantId)
    .is("effective_to", null)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TaxRow | null) ?? null;
}

export async function loadPaymentConnection(
  merchantId: string,
): Promise<PaymentRow | null> {
  const { data, error } = await supabase
    .from("payment_connections")
    .select(
      "id, provider, bank_code, account_name, account_masked, status, is_default",
    )
    .eq("merchant_id", merchantId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PaymentRow | null) ?? null;
}

// ── Today dashboard (Functional 02) reads ────────────────────────────────────
// The single boundary the client crosses for the dashboard. A future Node/Hono
// server layer can replace the bodies of these three functions (call an API
// instead of Supabase) without touching the dashboard components.

/**
 * Real-time dashboard snapshot via the `get_today_dashboard` RPC. The RPC does
 * its own merchant-role check and RLS also applies, so a user only ever gets
 * their own merchant's numbers. `p_business_date: null` → today in the
 * merchant's timezone (spec 3.3).
 */
export async function getTodayDashboard(
  merchantId: string,
): Promise<DashboardSnapshot> {
  const { data, error } = await supabase.rpc("get_today_dashboard", {
    p_merchant_id: merchantId,
    p_business_date: null,
  });
  if (error) throw new Error(error.message);
  return data as DashboardSnapshot;
}

export interface LowStockProduct {
  productId: string;
  name: string;
  onHand: number;
  threshold: number;
}

interface InventoryJoinRow {
  product_id: string;
  on_hand: number | string;
  low_stock_threshold: number | string;
  products: { id: string; name: string } | { id: string; name: string }[] | null;
}

/**
 * Top low-stock products (spec 3 "Tồn kho thấp"): active + inventory-tracked
 * products whose on_hand ≤ low_stock_threshold, most-depleted first. PostgREST
 * can't compare two columns, so we filter is_active/track_inventory server-side
 * and do the on_hand≤threshold comparison client-side over the (small) result.
 */
export async function loadLowStockProducts(
  merchantId: string,
  limit = 3,
): Promise<LowStockProduct[]> {
  const { data, error } = await supabase
    .from("inventory_levels")
    .select(
      "product_id, on_hand, low_stock_threshold, products!inner(id, name)",
    )
    .eq("merchant_id", merchantId)
    .eq("products.is_active", true)
    .eq("products.track_inventory", true);
  if (error) throw new Error(error.message);

  const rows = (data as InventoryJoinRow[] | null) ?? [];
  return rows
    .map((r) => {
      const p = Array.isArray(r.products) ? r.products[0] : r.products;
      return {
        productId: r.product_id,
        name: p?.name ?? "Sản phẩm",
        onHand: Number(r.on_hand),
        threshold: Number(r.low_stock_threshold),
      };
    })
    .filter((p) => p.onHand <= p.threshold)
    .sort((a, b) => a.onHand - b.onHand || a.name.localeCompare(b.name, "vi"))
    .slice(0, limit);
}

interface ActionItemRow {
  id: string;
  action_type: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string | null;
  entity_type: string | null;
  entity_id: string | null;
  detected_at: string;
}

/**
 * Open action_items ordered by severity then most-recent (FR-06). The
 * action_severity enum is declared critical→warning→info, so ordering the enum
 * column ascending already yields the P1→P3 priority order.
 */
export async function loadOpenActionItems(
  merchantId: string,
  limit = 10,
): Promise<OpenAction[]> {
  const { data, error } = await supabase
    .from("action_items")
    .select(
      "id, action_type, severity, title, description, entity_type, entity_id, detected_at",
    )
    .eq("merchant_id", merchantId)
    .eq("status", "open")
    .order("severity", { ascending: true })
    .order("detected_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const rows = (data as ActionItemRow[] | null) ?? [];
  return rows.map((r) => ({
    id: r.id,
    actionType: r.action_type,
    severity: r.severity,
    title: r.title,
    description: r.description,
    entityType: r.entity_type,
    entityId: r.entity_id,
    detectedAt: r.detected_at,
  }));
}

// ── Settings edits ───────────────────────────────────────────────────────────
export async function updateMerchantProfile(
  merchantId: string,
  patch: { displayName: string; legalName: string; taxCode: string },
): Promise<void> {
  const normalized = normalizeTaxCode(patch.taxCode);
  const { error } = await supabase
    .from("merchants")
    .update({
      display_name: patch.displayName.trim(),
      legal_name: patch.legalName.trim() || null,
      tax_code_normalized: normalized || null,
    })
    .eq("id", merchantId);
  if (error) throw new Error(error.message);
}

export async function updateTaxProfile(
  taxId: string,
  patch: {
    registrationStatus: RegistrationStatus;
    filingFrequency: FilingFrequency;
  },
): Promise<void> {
  const { error } = await supabase
    .from("merchant_tax_profiles")
    .update({
      registration_status: patch.registrationStatus,
      filing_frequency: patch.filingFrequency,
    })
    .eq("id", taxId);
  if (error) throw new Error(error.message);
}

export async function savePaymentConnection(
  merchantId: string,
  existing: PaymentRow | null,
  p: { bankCode: string; accountName: string; accountMasked: string },
): Promise<void> {
  if (existing) {
    const { error } = await supabase
      .from("payment_connections")
      .update({
        bank_code: p.bankCode || null,
        account_name: p.accountName.trim() || null,
        account_masked: p.accountMasked || existing.account_masked,
      })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    await insertPaymentConnection(merchantId, p);
  }
}
