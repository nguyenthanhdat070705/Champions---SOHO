import { Outlet, useLocation } from "react-router-dom";
import { BottomNav } from "./BottomNav";

// Persistent layout for the post-onboarding app: routed page + bottom nav.
// The QR screen is intentionally full-screen (immersive) with no bottom nav.
export function AppShell() {
  const { pathname } = useLocation();
  const immersive = pathname === "/qr";
  return (
    <>
      <Outlet />
      {!immersive && <BottomNav />}
    </>
  );
}
