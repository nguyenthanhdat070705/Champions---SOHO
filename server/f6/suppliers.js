// Functional 06 — minimal suppliers (spec 3.3 / 8.6 / product decision "NCC tối
// giản"). No AP, no supplier CRM: just a name (+ optional phone/note) so a receipt
// can carry a supplier reference, plus a snapshot of the name on the receipt so it
// never changes retroactively (spec 3.3 "lưu snapshot"). Unique per (merchant,
// name); a create that collides returns the existing row.
import { query } from "../db/pool.js";
import { fail } from "../f3/errors.js";

function mapSupplier(r) {
  return { id: r.id, name: r.name, phone: r.phone ?? null, note: r.note ?? null };
}

/** GET /receiving/suppliers — search by name (for the picker). */
export async function listSuppliers(merchantId, { search, limit } = {}) {
  const lim = Math.min(Math.max(1, Number(limit) || 30), 100);
  const params = [merchantId];
  let where = "merchant_id=$1";
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim().toLowerCase()}%`);
    where += ` and lower(name) like $${params.length}`;
  }
  params.push(lim);
  const { rows } = await query(
    `select id, name, phone, note from public.suppliers where ${where} order by lower(name) limit $${params.length}`,
    params,
  );
  return { suppliers: rows.map(mapSupplier) };
}

/** POST /receiving/suppliers — create or return the existing same-named supplier. */
export async function createSupplier(merchantId, userId, input = {}) {
  const name = String(input.name || "").trim().slice(0, 160);
  if (name.length < 1) fail("VALIDATION", "Nhập tên nhà cung cấp.");
  const phone = input.phone ? String(input.phone).trim().slice(0, 32) || null : null;
  const note = input.note ? String(input.note).trim().slice(0, 500) || null : null;

  // Idempotent on the (merchant, name) unique: on conflict, return the existing.
  const { rows } = await query(
    `insert into public.suppliers (merchant_id, name, phone, note)
     values ($1,$2,$3,$4)
     on conflict (merchant_id, name) do update set updated_at=now()
     returning id, name, phone, note`,
    [merchantId, name, phone, note],
  );
  return { supplier: mapSupplier(rows[0]) };
}
