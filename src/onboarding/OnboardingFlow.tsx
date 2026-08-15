import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { LoadingScreen } from "../components/ui";
import { emptyOnboardingData } from "../lib/types";
import type { OnboardingData } from "../lib/types";
import { completedSteps } from "../lib/validators";
import {
  createMerchantOnboarding,
  insertAddress,
  insertConsents,
  insertPaymentConnection,
  loadLatestOnboarding,
  saveDraft,
  updateProfileName,
} from "../lib/db";
import {
  Step1Welcome,
  Step2Auth,
  Step3Manager,
  Step4BusinessModel,
  Step5StoreProfile,
  Step6Tax,
  Step7Payment,
  Step8Review,
} from "./Steps";

export function OnboardingFlow({
  initialSession,
  onComplete,
}: {
  initialSession: Session | null;
  onComplete: (merchantId: string) => void;
}) {
  const [step, setStep] = useState(1);
  const [data, setData] = useState<OnboardingData>(emptyOnboardingData());
  const dataRef = useRef(data);
  const [session, setSession] = useState<Session | null>(initialSession);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"signup" | "signin">("signup");
  const [editReturn, setEditReturn] = useState(false);
  const [booting, setBooting] = useState(!!initialSession);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finishingRef = useRef(false);

  const email = session?.user.email ?? "";

  // Keep a synchronous mirror of form data so save/finish read the latest value
  // even in the same tick a step calls update() then advances.
  function update(patch: Partial<OnboardingData>) {
    dataRef.current = { ...dataRef.current, ...patch };
    setData(dataRef.current);
  }
  function setAllData(next: OnboardingData) {
    dataRef.current = next;
    setData(next);
  }

  async function persist(currentStep: number) {
    if (!session || !idempotencyKey) return;
    try {
      await saveDraft({
        userId: session.user.id,
        idempotencyKey,
        currentStep,
        completedSteps: completedSteps(dataRef.current),
        draftData: dataRef.current,
      });
    } catch {
      /* draft save is best-effort; never block navigation on it */
    }
  }

  // Runs after auth succeeds (fresh) or when resuming an authenticated session.
  async function syncAuthenticated(sess: Session) {
    setSession(sess);
    const userId = sess.user.id;
    const row = await loadLatestOnboarding(userId);

    if (row?.status === "completed" && row.merchant_id) {
      onComplete(row.merchant_id);
      return;
    }

    if (row?.status === "in_progress") {
      setIdempotencyKey(row.idempotency_key);
      if (row.draft_data) {
        setAllData({ ...emptyOnboardingData(), ...row.draft_data });
      }
      const resumeStep = Math.min(Math.max(row.current_step, 3), 8);
      setStep(resumeStep);
      return;
    }

    // Fresh authenticated onboarding: mint the idempotency key ONCE, record
    // consents captured on step 1, and create the progress row.
    const key = crypto.randomUUID();
    setIdempotencyKey(key);
    const cur = dataRef.current;
    if (cur.consents.terms && cur.consents.privacy) {
      try {
        await insertConsents(userId, cur.consents);
      } catch {
        /* consent log is best-effort here; do not block onboarding */
      }
    }
    try {
      await saveDraft({
        userId,
        idempotencyKey: key,
        currentStep: 3,
        completedSteps: completedSteps(cur),
        draftData: cur,
      });
    } catch {
      /* ignore */
    }
    setStep(3);
  }

  // Resume on mount if we already have a session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (initialSession) {
        try {
          await syncAuthenticated(initialSession);
        } catch {
          setError("Không tải được tiến trình. Vui lòng thử lại.");
        }
      }
      if (!cancelled) setBooting(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleNext(fromStep: number) {
    setError(null);
    setBusy(true);
    try {
      if (fromStep === 3 && session) {
        await updateProfileName(
          session.user.id,
          dataRef.current.fullName,
          session.user.email,
        );
      }
      const target = editReturn ? 8 : fromStep + 1;
      await persist(target);
      setEditReturn(false);
      setStep(target);
      window.scrollTo(0, 0);
    } catch (e) {
      setError((e as Error).message || "Có lỗi xảy ra, vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!session || !idempotencyKey || finishingRef.current) return;
    finishingRef.current = true; // single-flight guard against double-tap
    setBusy(true);
    setError(null);
    const d = dataRef.current;
    try {
      const merchantId = await createMerchantOnboarding({
        displayName: d.displayName,
        legalName: d.legalName,
        taxCode: d.taxCode,
        businessModel: d.businessModel!,
        registrationStatus: d.registrationStatus!,
        filingFrequency: d.filingFrequency!,
        idempotencyKey,
      });

      // Address + payment are follow-ups; a failure here must not lose the
      // merchant that was already created atomically by the RPC.
      try {
        await insertAddress(merchantId, {
          addressLine: d.addressLine,
          provinceText: d.provinceText,
          wardText: d.wardText,
        });
      } catch (e) {
        console.warn("address insert failed", e);
      }
      if (!d.payment.skipped) {
        try {
          await insertPaymentConnection(merchantId, {
            bankCode: d.payment.bankCode,
            accountName: d.payment.accountName,
            accountMasked: d.payment.accountMasked,
          });
        } catch (e) {
          console.warn("payment insert failed", e);
        }
      }
      onComplete(merchantId);
    } catch (e) {
      setError(
        (e as Error).message ||
          "Chưa tạo được cửa hàng. Vui lòng thử lại.",
      );
      finishingRef.current = false; // allow retry (RPC is idempotent per key)
      setBusy(false);
    }
  }

  if (booting) return <LoadingScreen />;

  switch (step) {
    case 1:
      return (
        <Step1Welcome
          data={data}
          update={update}
          onNext={() => {
            if (session) {
              // Already authenticated (edge case) — set up and jump past auth.
              void syncAuthenticated(session);
            } else {
              setAuthMode("signup");
              setStep(2);
            }
          }}
          onSignIn={() => {
            setAuthMode("signin");
            setStep(2);
          }}
        />
      );
    case 2:
      return (
        <Step2Auth
          initialMode={authMode}
          fullNameHint={data.fullName}
          onBack={() => setStep(1)}
          onAuthenticated={(s) => syncAuthenticated(s)}
        />
      );
    case 3:
      return (
        <Step3Manager
          data={data}
          update={update}
          email={email}
          onNext={() => handleNext(3)}
          onBack={() => setStep(editReturn ? 8 : 3)}
        />
      );
    case 4:
      return (
        <Step4BusinessModel
          data={data}
          update={update}
          onNext={() => handleNext(4)}
          onBack={() => setStep(editReturn ? 8 : 3)}
        />
      );
    case 5:
      return (
        <Step5StoreProfile
          data={data}
          update={update}
          onNext={() => handleNext(5)}
          onBack={() => setStep(editReturn ? 8 : 4)}
        />
      );
    case 6:
      return (
        <Step6Tax
          data={data}
          update={update}
          onNext={() => handleNext(6)}
          onBack={() => setStep(editReturn ? 8 : 5)}
        />
      );
    case 7:
      return (
        <Step7Payment
          data={data}
          update={update}
          onNext={() => handleNext(7)}
          onBack={() => setStep(editReturn ? 8 : 6)}
        />
      );
    case 8:
      return (
        <Step8Review
          data={data}
          email={email}
          busy={busy}
          error={error}
          onEdit={(n) => {
            setEditReturn(true);
            setStep(n);
          }}
          onBack={() => setStep(7)}
          onFinish={finish}
        />
      );
    default:
      return <LoadingScreen />;
  }
}
