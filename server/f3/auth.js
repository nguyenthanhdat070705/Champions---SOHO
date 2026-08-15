// Caller authentication + authorization for the Functional 03 server. Because
// the pooler connection bypasses RLS, EVERY mutation path must call verifyUser()
// and requireMembership() before touching money/inventory (NFR-04). The client
// never sends a trusted user/merchant id — identity comes from the JWT.
import { createClient } from "@supabase/supabase-js";
import { query } from "../db/pool.js";
import { DomainError } from "./errors.js";
import { supabaseAnonKey, supabaseUrl } from "./env.js";

let authClient = null;
function getAuthClient() {
  if (!authClient) {
    authClient = createClient(supabaseUrl(), supabaseAnonKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return authClient;
}

// Tiny positive-result cache so repeated calls in one request burst don't each
// round-trip to the Auth server. Tokens are short-lived; a 30s TTL is safe.
const userCache = new Map(); // token -> { user, exp }
const USER_TTL_MS = 30_000;

/** Extract the Bearer token from the Authorization header, or throw 401. */
export function getBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const [scheme, token] = String(header).split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new DomainError("UNAUTHORIZED");
  }
  return token.trim();
}

/** Validate the JWT via Supabase Auth and return { userId, email }. */
export async function verifyUser(req) {
  const token = getBearerToken(req);
  const cached = userCache.get(token);
  if (cached && cached.exp > Date.now()) return cached.user;

  const { data, error } = await getAuthClient().auth.getUser(token);
  if (error || !data?.user) {
    throw new DomainError("UNAUTHORIZED");
  }
  const user = { userId: data.user.id, email: data.user.email ?? null };
  userCache.set(token, { user, exp: Date.now() + USER_TTL_MS });
  return user;
}

/**
 * Load the caller's ACTIVE membership of a merchant, or throw FORBIDDEN. When
 * `allowedRoles` is given, the role must be one of them (spec 13.1 RBAC). This
 * is the server-side ownership check that RLS would enforce for the client.
 * @returns {Promise<{ role: string }>}
 */
export async function requireMembership(userId, merchantId, allowedRoles) {
  if (!merchantId) throw new DomainError("VALIDATION", "Thiếu merchantId.");
  const { rows } = await query(
    `select role from public.merchant_members
       where merchant_id = $1 and user_id = $2 and status = 'active' limit 1`,
    [merchantId, userId],
  );
  if (rows.length === 0) throw new DomainError("FORBIDDEN");
  const role = rows[0].role;
  if (allowedRoles && !allowedRoles.includes(role)) {
    throw new DomainError("FORBIDDEN");
  }
  return { role };
}

/** Roles allowed to run a sale / take payment (spec 13.1). */
export const SELLING_ROLES = ["owner", "manager", "cashier"];
/** Roles allowed to approve over-threshold discounts / refunds (spec 13.1). */
export const PRIVILEGED_ROLES = ["owner", "manager"];
