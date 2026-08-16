import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { getSession, onAuthChange } from "./lib/auth";
import { loadMyMerchant } from "./lib/db";
import { LoadingScreen } from "./components/ui";
import { OnboardingFlow } from "./onboarding/OnboardingFlow";
import { MerchantProvider } from "./dashboard/MerchantContext";
import { AppShell } from "./dashboard/AppShell";
import { Home } from "./dashboard/Home";
import { AttentionListPage } from "./dashboard/AttentionListPage";
import { TaxPage } from "./dashboard/TaxPage";
import { SettingsPage } from "./dashboard/SettingsPage";
import { QRScreen, ReportsPage } from "./dashboard/pages";
import { SalesFlow } from "./sales/SalesFlow";
import { OrdersPage } from "./orders/OrdersPage";
import { OrderDetail } from "./orders/OrderDetail";
import { AssistantPage } from "./assistant/AssistantPage";
import { CatalogPage } from "./catalog/CatalogPage";
import { ProductForm } from "./catalog/ProductForm";
import { ProductDetail } from "./catalog/ProductDetail";
import { InventoryPage } from "./inventory/InventoryPage";
import { InventoryLedger } from "./inventory/InventoryLedger";
import { CountList } from "./inventory/CountList";
import { CountCreate } from "./inventory/CountCreate";
import { CountSession } from "./inventory/CountSession";
import { Reconciliation } from "./inventory/Reconciliation";
import { ReceivingList } from "./receiving/ReceivingList";
import { ReceiptScreen } from "./receiving/ReceiptScreen";
import { ExpensesPage } from "./expenses/ExpensesPage";
import { ExpenseForm } from "./expenses/ExpenseForm";
import { ExpenseDetail } from "./expenses/ExpenseDetail";
import { DocumentsPage } from "./documents/DocumentsPage";
import { DocumentDetail } from "./documents/DocumentDetail";
import { EInvoicePage } from "./einvoice/EInvoicePage";
import { CreateInvoice } from "./einvoice/CreateInvoice";
import { InvoiceDetail } from "./einvoice/InvoiceDetail";

type Phase = "loading" | "onboarding" | "app";

export default function App() {
  const nav = useNavigate();
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const s = await getSession();
      if (!active) return;
      setSession(s);
      if (!s) {
        setPhase("onboarding");
        return;
      }
      try {
        const merchant = await loadMyMerchant(s.user.id);
        if (!active) return;
        setPhase(merchant ? "app" : "onboarding");
      } catch {
        if (active) setPhase("onboarding");
      }
    })();

    const unsub = onAuthChange((s) => {
      setSession(s);
      if (!s) setPhase("onboarding");
    });

    return () => {
      active = false;
      unsub();
    };
  }, []);

  function handleComplete() {
    setPhase("app");
    nav("/", { replace: true });
  }

  let body: React.ReactNode;
  if (phase === "loading") {
    body = <LoadingScreen />;
  } else if (phase === "onboarding") {
    body = (
      <OnboardingFlow initialSession={session} onComplete={handleComplete} />
    );
  } else {
    body = (
      <MerchantProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<Home />} />
            <Route path="/tro-ly" element={<AssistantPage />} />
            <Route path="/viec-can-xu-ly" element={<AttentionListPage />} />
            <Route path="/ban-hang" element={<SalesFlow />} />
            <Route path="/don-hang" element={<OrdersPage />} />
            <Route path="/don-hang/:id" element={<OrderDetail />} />
            <Route path="/kho" element={<CatalogPage />} />
            <Route path="/kho/moi" element={<ProductForm />} />
            <Route path="/kho/:id" element={<ProductDetail />} />
            <Route path="/kho/:id/sua" element={<ProductForm />} />
            <Route path="/ton-kho" element={<InventoryPage />} />
            <Route path="/ton-kho/doi-chieu" element={<Reconciliation />} />
            <Route path="/ton-kho/kiem-kho" element={<CountList />} />
            <Route path="/ton-kho/kiem-kho/moi" element={<CountCreate />} />
            <Route path="/ton-kho/kiem-kho/:id" element={<CountSession />} />
            <Route path="/ton-kho/:productId" element={<InventoryLedger />} />
            <Route path="/nhap-hang" element={<ReceivingList />} />
            <Route path="/nhap-hang/:id" element={<ReceiptScreen />} />
            <Route path="/chi-phi" element={<ExpensesPage />} />
            <Route path="/chi-phi/moi" element={<ExpenseForm />} />
            <Route path="/chi-phi/:id" element={<ExpenseDetail />} />
            <Route path="/chung-tu" element={<DocumentsPage />} />
            <Route path="/chung-tu/:id" element={<DocumentDetail />} />
            <Route path="/hoa-don" element={<EInvoicePage />} />
            <Route path="/hoa-don/tao" element={<CreateInvoice />} />
            <Route path="/hoa-don/:id" element={<InvoiceDetail />} />
            <Route path="/bao-cao" element={<ReportsPage />} />
            <Route path="/thue" element={<TaxPage />} />
            <Route path="/cai-dat" element={<SettingsPage />} />
            <Route path="/qr" element={<QRScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </MerchantProvider>
    );
  }

  return <div className="app-shell">{body}</div>;
}
