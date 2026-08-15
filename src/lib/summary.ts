// AI summary layer for the Today dashboard (spec 9). Today there is NO AI key,
// so the ONLY implementation is the deterministic fallback template from spec
// 9.4. It is structured as a pluggable provider so a real AI provider can be
// dropped in later without touching the dashboard: implement SummaryProvider,
// pass it to getSummary(), and the same guardrails + fallback still apply.

import type { DashboardSnapshot } from "./dashboard";
import { formatVnd } from "./format";

export interface SummaryResult {
  headline: string;
  summary: string;
  /** Action refs — always [] for the deterministic template (spec 9.4). */
  priorities: never[];
  /** "fallback" until a real AI provider is wired in (spec 6.8 status). */
  status: "fallback" | "generated";
}

export interface SummaryProvider {
  /** Produce a summary from the snapshot, or throw/return null to fall back. */
  generate(snapshot: DashboardSnapshot): Promise<SummaryResult | null>;
}

/**
 * Words the summary must never contain (spec 9.1 / 9.3): SoHo has no credit
 * sales, so "công nợ" / "chưa thu" are forbidden, and it makes no tax claims.
 */
const FORBIDDEN_TERMS = ["công nợ", "chưa thu", "phải thu"];

export function containsForbiddenTerms(text: string): boolean {
  const lower = text.toLowerCase();
  return FORBIDDEN_TERMS.some((t) => lower.includes(t));
}

/**
 * The deterministic fallback (spec 9.4): net revenue + completed-bill count,
 * plus a pending-QR sentence that states such transactions are not counted as
 * revenue. Never invents numbers not present in the snapshot.
 */
export function fallbackSummary(s: DashboardSnapshot): SummaryResult {
  const money = formatVnd(s.netSalesAmount);
  const actionText =
    s.pendingQrCount > 0
      ? ` Có ${s.pendingQrCount} giao dịch QR đang chờ xác nhận; chưa tính vào doanh thu.`
      : "";
  return {
    headline: `Hôm nay: ${money}`,
    summary: `Cửa hàng đã hoàn tất ${s.paidOrderCount} bill.${actionText}`,
    priorities: [],
    status: "fallback",
  };
}

/**
 * Get the summary for a snapshot. With no provider (the current state) this is
 * always the deterministic fallback. With a provider, its output is validated
 * against the forbidden-term guardrail; anything failing falls back safely so a
 * bad/late AI response can never block or corrupt the dashboard (FR-09/FR-10).
 */
export async function getSummary(
  snapshot: DashboardSnapshot,
  provider?: SummaryProvider | null,
): Promise<SummaryResult> {
  if (!provider) return fallbackSummary(snapshot);
  try {
    const result = await provider.generate(snapshot);
    if (
      result &&
      !containsForbiddenTerms(result.headline) &&
      !containsForbiddenTerms(result.summary)
    ) {
      return result;
    }
  } catch {
    // fall through to the deterministic template
  }
  return fallbackSummary(snapshot);
}
