// Bottom sheets for the pick screen: quick-create a product (spec 3.4), scan a
// barcode via the BarcodeDetector API with a manual-entry fallback (spec 3.3),
// and enter a line/order discount with a reason (spec 3.6). All three reuse the
// shared Sheet primitive.
import { useEffect, useRef, useState } from "react";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { ApiProduct } from "../lib/api";
import { formatVnd } from "../lib/format";
import { Sheet, InlineError } from "./ui";
import type { LineDiscount } from "./cartStore";

const UNITS = [
  { value: "item", label: "Cái" }, { value: "chai", label: "Chai" }, { value: "goi", label: "Gói" },
  { value: "kg", label: "Kg" }, { value: "lit", label: "Lít" }, { value: "phan", label: "Phần" }, { value: "lan", label: "Lần" },
];

// ── Quick-create product ─────────────────────────────────────────────────────
export function QuickCreateSheet({
  open, merchantId, initialBarcode, onClose, onCreated,
}: {
  open: boolean;
  merchantId: string;
  initialBarcode?: string;
  onClose: () => void;
  onCreated: (p: ApiProduct) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [unit, setUnit] = useState("item");
  const [track, setTrack] = useState(true);
  const [stock, setStock] = useState("");
  const [threshold, setThreshold] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idemKey = useRef<string>(newIdempotencyKey());

  useEffect(() => {
    if (open) {
      setName(""); setPrice(""); setUnit("item"); setTrack(true); setStock(""); setThreshold(""); setError(null);
      idemKey.current = newIdempotencyKey();
    }
  }, [open]);

  const valid = name.trim().length >= 1 && Number(price) >= 0 && price !== "";

  async function create() {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await api.quickCreateProduct(merchantId, {
        name: name.trim(), salePrice: Math.trunc(Number(price)), unitCode: unit,
        trackInventory: track, initialStock: track ? Number(stock) || 0 : 0,
        lowStockThreshold: track ? Number(threshold) || 0 : 0,
        barcode: initialBarcode,
      }, idemKey.current);
      onCreated(res.product);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được sản phẩm.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Tạo hàng nhanh"
      footer={
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn--outline" onClick={onClose}>Hủy</button>
          <button className="btn btn--primary" disabled={!valid || busy} onClick={create}>
            {busy ? <span className="spinner spinner--sm spinner--light" /> : "Tạo & thêm"}
          </button>
        </div>
      }
    >
      {error && <InlineError message={error} onClose={() => setError(null)} />}
      <div className="field">
        <label className="field__label">Tên hàng <span className="field__req">*</span></label>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Nước suối 500ml" maxLength={160} />
      </div>
      <div className="field">
        <label className="field__label">Giá bán <span className="field__req">*</span></label>
        <input className="input" value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="10000" />
        {price && <div className="field__hint">{formatVnd(Number(price))}</div>}
      </div>
      <div className="field">
        <label className="field__label">Đơn vị</label>
        <select className="input" value={unit} onChange={(e) => setUnit(e.target.value)}>
          {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
        </select>
      </div>
      <div className="switch-row" onClick={() => setTrack((v) => !v)}>
        <div>
          <div className="switch-row__t">Theo dõi tồn kho</div>
          <div className="switch-row__d">Bật để trừ tồn khi bán</div>
        </div>
        <span className={`switch ${track ? "switch--on" : ""}`}><span className="switch__dot" /></span>
      </div>
      {track && (
        <div style={{ display: "flex", gap: 10 }}>
          <div className="field" style={{ flex: 1 }}>
            <label className="field__label">Tồn ban đầu</label>
            <input className="input" value={stock} onChange={(e) => setStock(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder="0" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label className="field__label">Ngưỡng thấp</label>
            <input className="input" value={threshold} onChange={(e) => setThreshold(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder="0" />
          </div>
        </div>
      )}
    </Sheet>
  );
}

// ── Barcode scan ─────────────────────────────────────────────────────────────
interface BarcodeDetectorLike { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]>; }
interface BarcodeDetectorCtor { new (opts?: { formats?: string[] }): BarcodeDetectorLike; }

export function ScanSheet({
  open, merchantId, onClose, onFound, onNotFound,
}: {
  open: boolean;
  merchantId: string;
  onClose: () => void;
  onFound: (p: ApiProduct) => void;
  onNotFound: (barcode: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [manual, setManual] = useState("");
  const [status, setStatus] = useState<string>("");
  const [supported, setSupported] = useState(true);
  const streamRef = useRef<MediaStream | null>(null);
  const lastScan = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const rafRef = useRef<number | null>(null);
  const busyRef = useRef(false);

  async function lookup(code: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setStatus("Đang tìm…");
    try {
      const { products } = await api.listProducts(merchantId, { barcode: code });
      if (products.length > 0) { onFound(products[0]); setStatus("Đã thêm ✓"); }
      else { stop(); onNotFound(code); }
    } catch { setStatus("Lỗi tìm kiếm"); }
    finally { setTimeout(() => { busyRef.current = false; setStatus(""); }, 900); }
  }

  function stop() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  useEffect(() => {
    if (!open) { stop(); return; }
    const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (!Detector || !navigator.mediaDevices?.getUserMedia) { setSupported(false); return; }
    let cancelled = false;
    const detector = new Detector({ formats: ["ean_13", "ean_8", "code_128", "upc_a", "qr_code"] });
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        const scan = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes[0]?.rawValue) {
              const code = codes[0].rawValue;
              const now = Date.now();
              if (!(lastScan.current.code === code && now - lastScan.current.at < 1500)) {
                lastScan.current = { code, at: now };
                void lookup(code);
              }
            }
          } catch { /* frame not ready */ }
          rafRef.current = requestAnimationFrame(scan);
        };
        rafRef.current = requestAnimationFrame(scan);
      } catch { setSupported(false); }
    })();
    return () => { cancelled = true; stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, merchantId]);

  return (
    <Sheet open={open} onClose={() => { stop(); onClose(); }} title="Quét mã vạch">
      {supported ? (
        <div className="scan-view">
          <video ref={videoRef} className="scan-video" muted playsInline />
          <div className="scan-frame" />
          {status && <div className="scan-status">{status}</div>}
        </div>
      ) : (
        <div className="muted tiny" style={{ marginBottom: 10 }}>Thiết bị không hỗ trợ quét bằng camera. Hãy nhập mã thủ công.</div>
      )}
      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">Nhập mã thủ công</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="input" value={manual} onChange={(e) => setManual(e.target.value)} inputMode="numeric" placeholder="Mã vạch / SKU" />
          <button className="btn btn--outline" style={{ width: "auto", padding: "0 18px" }} disabled={!manual.trim()} onClick={() => lookup(manual.trim())}>Tìm</button>
        </div>
      </div>
    </Sheet>
  );
}

// ── Discount entry ────────────────────────────────────────────────────────────
export function DiscountSheet({
  open, scope, current, base, onClose, onApply,
}: {
  open: boolean;
  scope: "line" | "order";
  current: LineDiscount | null;
  base: number;
  onClose: () => void;
  onApply: (d: LineDiscount | null) => void;
}) {
  const [mode, setMode] = useState<"percent" | "fixed">("percent");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("customer_change");

  useEffect(() => {
    if (open) {
      setMode(current?.kind ?? "percent");
      setValue(current ? String(current.kind === "percent" ? current.rate ?? "" : current.amount ?? "") : "");
      setReason(current?.reasonCode ?? "customer_change");
    }
  }, [open, current]);

  const num = Number(value || "0");
  const computed = mode === "percent" ? Math.round((base * Math.min(100, num)) / 100) : Math.min(base, num);
  const valid = num > 0 && (mode === "percent" ? num <= 100 : num <= base);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={scope === "order" ? "Giảm giá toàn bill" : "Giảm giá dòng"}
      footer={
        <div style={{ display: "flex", gap: 10 }}>
          {current && <button className="btn btn--danger" onClick={() => onApply(null)}>Xóa</button>}
          <button className="btn btn--primary" disabled={!valid} onClick={() => onApply({ kind: mode, rate: mode === "percent" ? num : undefined, amount: mode === "fixed" ? num : undefined, reasonCode: reason })}>Áp dụng</button>
        </div>
      }
    >
      <div className="segment" style={{ marginBottom: 14 }}>
        <button className={`segment__btn ${mode === "percent" ? "segment__btn--on" : ""}`} onClick={() => setMode("percent")}>Theo %</button>
        <button className={`segment__btn ${mode === "fixed" ? "segment__btn--on" : ""}`} onClick={() => setMode("fixed")}>Số tiền</button>
      </div>
      <div className="field">
        <label className="field__label">{mode === "percent" ? "Phần trăm giảm" : "Số tiền giảm"}</label>
        <input className="input" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder={mode === "percent" ? "10" : "5000"} />
        <div className="field__hint">Giảm {formatVnd(computed)} trên {formatVnd(base)}</div>
      </div>
      <div className="field">
        <label className="field__label">Lý do</label>
        <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="customer_change">Khách quen</option>
          <option value="promotion">Khuyến mãi</option>
          <option value="damaged">Hàng cận hạn/lỗi nhẹ</option>
          <option value="other">Khác</option>
        </select>
      </div>
    </Sheet>
  );
}
