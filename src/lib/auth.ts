// All Supabase Auth calls live here so a later swap to phone OTP is a one-file
// change. Today the project uses EMAIL + PASSWORD (phone OTP is disabled on the
// Supabase project — no SMS provider). The UI labels this honestly.
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type AuthResult = {
  ok: boolean;
  session: Session | null;
  /** True when sign-up succeeded but the email must be confirmed first. */
  needsConfirmation: boolean;
  /** True when sign-up failed because the email already has an account. */
  alreadyExists: boolean;
  /** Vietnamese, user-facing error message when ok is false. */
  error: string | null;
};

const ok = (session: Session | null): AuthResult => ({
  ok: true,
  session,
  needsConfirmation: false,
  alreadyExists: false,
  error: null,
});

function mapError(message: string): AuthResult {
  const m = message.toLowerCase();
  let error = message;
  let alreadyExists = false;
  let needsConfirmation = false;

  if (m.includes("already registered") || m.includes("already been registered")) {
    alreadyExists = true;
    error = "Email này đã có tài khoản. Hãy đăng nhập.";
  } else if (m.includes("invalid login credentials")) {
    error = "Email hoặc mật khẩu chưa đúng.";
  } else if (m.includes("email not confirmed")) {
    needsConfirmation = true;
    error = "Email chưa được xác nhận. Vui lòng kiểm tra hộp thư để xác nhận.";
  } else if (m.includes("password") && m.includes("6")) {
    error = "Mật khẩu cần ít nhất 6 ký tự.";
  } else if (m.includes("rate limit") || m.includes("too many")) {
    error = "Bạn thao tác hơi nhanh. Vui lòng thử lại sau ít phút.";
  } else if (m.includes("invalid") && m.includes("email")) {
    error = "Địa chỉ email không hợp lệ.";
  }

  return { ok: false, session: null, needsConfirmation, alreadyExists, error };
}

export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

export function onAuthChange(cb: (session: Session | null) => void) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    cb(session ?? null);
  });
  return () => data.subscription.unsubscribe();
}

export async function signUpEmail(
  email: string,
  password: string,
  fullName?: string,
): Promise<AuthResult> {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: fullName ? { data: { full_name: fullName.trim() } } : undefined,
  });
  if (error) return mapError(error.message);

  // When email confirmation is required, signUp returns a user but no session.
  if (!data.session) {
    return {
      ok: true,
      session: null,
      needsConfirmation: true,
      alreadyExists: false,
      error: null,
    };
  }
  return ok(data.session);
}

export async function signInEmail(
  email: string,
  password: string,
): Promise<AuthResult> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });
  if (error) return mapError(error.message);
  return ok(data.session);
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
