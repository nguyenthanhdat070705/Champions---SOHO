import { Outlet, useLocation } from "react-router-dom";
import { BottomNav } from "./BottomNav";

// Persistent layout for the post-onboarding app: routed page + bottom nav.
// The QR screen is intentionally full-screen (immersive) with no bottom nav.
export function AppShell() {
  const { pathname } = useLocation();
  // Full-flow screens carry their own bottom CTA / back nav, so the tab bar is
  // hidden to avoid overlap: QR scanner, the POS sell flow, and bill detail.
  const immersive =
    pathname === "/qr" ||
    pathname === "/ban-hang" ||
    /^\/don-hang\/[^/]+$/.test(pathname);
  return (
    <>
      <Outlet />
      {!immersive && <BottomNav />}
    </>
  );
}
