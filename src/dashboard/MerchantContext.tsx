import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";
import { getSession } from "../lib/auth";
import {
  loadMyMerchant,
  loadPaymentConnection,
  loadTaxProfile,
} from "../lib/db";
import type { MerchantRow, PaymentRow, TaxRow } from "../lib/db";

interface MerchantState {
  loading: boolean;
  error: string | null;
  merchant: MerchantRow | null;
  tax: TaxRow | null;
  payment: PaymentRow | null;
  email: string;
  refresh: () => Promise<void>;
}

const Ctx = createContext<MerchantState | null>(null);

export function MerchantProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [merchant, setMerchant] = useState<MerchantRow | null>(null);
  const [tax, setTax] = useState<TaxRow | null>(null);
  const [payment, setPayment] = useState<PaymentRow | null>(null);
  const [email, setEmail] = useState("");

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const session = await getSession();
      if (!session) {
        setMerchant(null);
        return;
      }
      setEmail(session.user.email ?? "");
      const m = await loadMyMerchant(session.user.id);
      setMerchant(m);
      if (m) {
        const [t, p] = await Promise.all([
          loadTaxProfile(m.id),
          loadPaymentConnection(m.id),
        ]);
        setTax(t);
        setPayment(p);
      }
    } catch (e) {
      setError((e as Error).message || "Không tải được dữ liệu cửa hàng.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Ctx.Provider
      value={{ loading, error, merchant, tax, payment, email, refresh }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useMerchant(): MerchantState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMerchant must be used within MerchantProvider");
  return v;
}
