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
    /^\/don-hang\/[^/]+$/.test(pathname) ||
    // Catalog detail / create / edit carry their own bottom CTA (spec F04 3.7/3.8);
    // the list at /kho keeps the tab bar (its FAB clears the nav).
    /^\/kho\/.+/.test(pathname) ||
    // Inventory (F05): the ledger, count create + count session carry their own
    // bottom CTA, so hide the tab bar to avoid overlap. The overview (/ton-kho),
    // count list (/ton-kho/kiem-kho) and reconciliation use a FAB/list → keep nav.
    /^\/ton-kho\/kiem-kho\/.+/.test(pathname) ||
    (/^\/ton-kho\/[^/]+$/.test(pathname) &&
      pathname !== "/ton-kho/kiem-kho" &&
      pathname !== "/ton-kho/doi-chieu") ||
    // Receiving (F06): the receipt editor/detail carry their own bottom CTA; the
    // list at /nhap-hang keeps the tab bar (its FAB clears the nav).
    /^\/nhap-hang\/.+/.test(pathname) ||
    // Expenses (F07): the quick form and the detail/reverse screen carry their own
    // bottom CTA; the list at /chi-phi keeps the tab bar (its FAB clears the nav).
    /^\/chi-phi\/.+/.test(pathname) ||
    // Documents (F08): detail carries its own back header + action bar; the list
    // at /chung-tu keeps the tab bar (its FAB clears the nav).
    /^\/chung-tu\/[^/]+$/.test(pathname);
  return (
    <>
      <Outlet />
      {!immersive && <BottomNav />}
    </>
  );
}
