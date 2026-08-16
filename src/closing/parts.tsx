// Functional 14 — shared bits for the "Chốt tiền cuối ngày" screens.
import { formatVnd } from "../lib/format";
import { classifyVariance, signedVnd, varianceHeadline } from "../lib/closing";
import type { VarianceClass } from "../lib/closing";

const STATUS_LABEL: Record<string, string> = {
  draft: "Đang làm", ready: "Sẵn sàng", confirmed: "Đã chốt", attention: "Cần xem", none: "Chưa chốt",
};

/** Closing status pill (spec §3.1 hero card states). */
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_LABEL[status] ? status : "none";
  return <span className={`cls-badge cls-badge--${s}`}>{STATUS_LABEL[s]}</span>;
}

/** The expected / counted / variance hero (spec §3.5). */
export function VarianceHero({
  expected, counted, variance,
}: {
  expected: number; counted: number | null; variance: number | null;
}) {
  const cls: VarianceClass = variance === null ? null : classifyVariance(variance);
  return (
    <div className={`cls-hero cls-hero--${cls ?? "none"}`}>
      <div className="cls-hero__label">{varianceHeadline(variance)}</div>
      <div className="cls-hero__var">
        {variance === null ? "—" : signedVnd(variance, formatVnd)}
      </div>
      <div className="cls-hero__row">
        <div className="cls-hero__cell">
          <span className="cls-hero__k">Kỳ vọng</span>
          <span className="cls-hero__v">{formatVnd(expected)}</span>
        </div>
        <div className="cls-hero__cell">
          <span className="cls-hero__k">Đã đếm</span>
          <span className="cls-hero__v">{counted === null ? "—" : formatVnd(counted)}</span>
        </div>
      </div>
    </div>
  );
}

/** Signed VND amount cell used across source/attention lists. */
export function DirAmount({ direction, amount }: { direction: "in" | "out"; amount: number }) {
  return (
    <span className={`cls-amt cls-amt--${direction}`}>
      {direction === "in" ? "+" : "−"}{formatVnd(amount)}
    </span>
  );
}
