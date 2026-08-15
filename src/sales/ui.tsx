// Shared POS UI primitives: bottom Sheet, numeric Keypad, and a lightweight
// undo Toast. Styled with the existing SoHo design tokens (see the "POS" block
// appended to src/index.css).
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import QRCode from "qrcode";
import { IconClose } from "../components/icons";

// ── VietQR renderer ──────────────────────────────────────────────────────────
// Renders the provider's EMV/VietQR payload string as a scannable QR image.
export function QrImage({ payload, size = 240 }: { payload: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(payload, { width: size, margin: 1, errorCorrectionLevel: "M" })
      .then((url) => { if (active) setSrc(url); })
      .catch(() => { if (active) setSrc(null); });
    return () => { active = false; };
  }, [payload, size]);
  if (!src) return <div className="qr-img qr-img--loading" style={{ width: size, height: size }}><div className="spinner" /></div>;
  return <img className="qr-img" src={src} width={size} height={size} alt="Mã QR thanh toán" />;
}

// ── Bottom sheet ─────────────────────────────────────────────────────────────
export function Sheet({
  open, onClose, title, children, footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sheet__grip" />
        <div className="sheet__head">
          <div className="sheet__title">{title}</div>
          <button className="sheet__x" onClick={onClose} aria-label="Đóng">
            <IconClose size={20} />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        {footer && <div className="sheet__foot">{footer}</div>}
      </div>
    </div>
  );
}

// ── Numeric keypad (đồng entry) ──────────────────────────────────────────────
export function Keypad({ onKey }: { onKey: (k: string) => void }) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "000", "0", "⌫"];
  return (
    <div className="keypad">
      {keys.map((k) => (
        <button key={k} className={`keypad__key ${k === "⌫" ? "keypad__key--del" : ""}`} onClick={() => onKey(k)}>
          {k}
        </button>
      ))}
    </div>
  );
}

/** Apply a keypad key to a numeric string, returning the new digits. */
export function applyKey(current: string, key: string): string {
  if (key === "⌫") return current.slice(0, -1);
  const next = (current === "0" ? "" : current) + key;
  // cap length to avoid overflow of VND integers
  return next.replace(/^0+(?=\d)/, "").slice(0, 12);
}

// ── Undo toast ────────────────────────────────────────────────────────────────
export function useUndoToast() {
  const [toast, setToast] = useState<{ label: string; onUndo: () => void } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function show(label: string, onUndo: () => void) {
    if (timer.current) clearTimeout(timer.current);
    setToast({ label, onUndo });
    timer.current = setTimeout(() => setToast(null), 5000);
  }
  function dismiss() {
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
  }
  const node = toast ? (
    <div className="undo-toast">
      <span>{toast.label}</span>
      <button onClick={() => { toast.onUndo(); dismiss(); }}>Hoàn tác</button>
    </div>
  ) : null;
  return { show, node };
}

// ── Inline error banner ───────────────────────────────────────────────────────
export function InlineError({ message, onClose }: { message: string; onClose?: () => void }) {
  return (
    <div className="banner banner--error" style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
      <span>{message}</span>
      {onClose && <button className="sheet__x" onClick={onClose} aria-label="Đóng"><IconClose size={16} /></button>}
    </div>
  );
}
