// Short hardcoded list of common Vietnamese banks for the QR connection form.
// bank_code stored in payment_connections.bank_code.
export interface Bank {
  code: string;
  name: string;
}

export const VN_BANKS: Bank[] = [
  { code: "VCB", name: "Vietcombank" },
  { code: "TCB", name: "Techcombank" },
  { code: "BIDV", name: "BIDV" },
  { code: "VTB", name: "VietinBank" },
  { code: "MB", name: "MB Bank" },
  { code: "ACB", name: "ACB" },
  { code: "VPB", name: "VPBank" },
  { code: "AGR", name: "Agribank" },
  { code: "TPB", name: "TPBank" },
  { code: "STB", name: "Sacombank" },
];

export const BANK_NAME_BY_CODE: Record<string, string> = Object.fromEntries(
  VN_BANKS.map((b) => [b.code, b.name]),
);
