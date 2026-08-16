import { describe, it, expect } from "vitest";
import {
  MAX_UPLOAD_BYTES, ACCEPT_MIME, DOC_TYPE_OPTIONS, docTypeLabel, docTypeTone,
  docStatusLabel, formatBytes, checkFile, linkTypeLabel, TARGET_TYPE_OPTIONS,
} from "./documents";

describe("documents helpers", () => {
  it("mirrors the server MIME allowlist + cap (image only)", () => {
    expect(ACCEPT_MIME).toEqual(["image/jpeg", "image/png", "image/webp"]);
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it("checkFile gates mime + size", () => {
    expect(checkFile("image/png", 1000).ok).toBe(true);
    expect(checkFile("image/jpeg", MAX_UPLOAD_BYTES).ok).toBe(true);
    expect(checkFile("application/pdf", 1000)).toEqual({ ok: false, reason: expect.stringContaining("JPG") });
    expect(checkFile("image/png", 0).ok).toBe(false);
    expect(checkFile("image/png", MAX_UPLOAD_BYTES + 1)).toEqual({ ok: false, reason: expect.stringContaining("lớn") });
  });

  it("labels document types + a fallback", () => {
    expect(DOC_TYPE_OPTIONS.map((o) => o.value)).toEqual(
      ["purchase_invoice", "goods_receipt", "expense", "sales_invoice", "other"]);
    expect(docTypeLabel("expense")).toBe("Chứng từ chi");
    expect(docTypeLabel(null)).toBe("Chưa phân loại");
    expect(docTypeTone("expense")).toBe("amber");
    expect(docTypeTone(null)).toBe("grey");
  });

  it("labels statuses + link types + targets", () => {
    expect(docStatusLabel("ready")).toBe("Sẵn sàng");
    expect(docStatusLabel("quarantined")).toBe("Bị cách ly");
    expect(linkTypeLabel("primary")).toBe("Chứng từ chính");
    expect(TARGET_TYPE_OPTIONS.map((o) => o.value)).toEqual(["order", "expense", "purchase_receipt"]);
  });

  it("formats bytes", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
