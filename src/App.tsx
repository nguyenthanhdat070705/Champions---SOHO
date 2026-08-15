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
import { InventoryPage } from "./inventory/InventoryPage";
import { AssistantPage } from "./assistant/AssistantPage";

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
            <Route path="/kho" element={<InventoryPage />} />
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
