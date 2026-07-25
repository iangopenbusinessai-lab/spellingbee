// _shared/mod.ts — plumbing shared by the Session 9a edge functions.
//
// Zero dependencies on purpose: everything here is plain fetch against the
// project's own REST/Auth endpoints, matching supabase/scripts/verify.mjs. That
// keeps the deployed bundle tiny and removes any Deno import-resolution risk.
//
// The division of labour (see 0006_round_engine.sql for the other half):
//   here            -> who is calling? is the request well-formed?
//   the SQL function -> the atomic state transition
//
// Nothing in this file decides game outcomes.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// All three are injected by the Supabase platform. The service_role key exists
// only in this runtime — it is never committed and never shipped to a browser.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function fail(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error, ...extra }, status);
}

/**
 * Resolve the caller's user id from their bearer token.
 *
 * This asks the Auth server to validate the token rather than decoding the JWT
 * locally: the identity that drives every host/membership check must come from
 * the token itself, not from anything the client put in the request body. A
 * caller can therefore only ever act as themselves.
 */
export async function getCallerId(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;

  const user = await res.json();
  return typeof user?.id === "string" ? user.id : null;
}

/**
 * Call one of the 0006 SQL functions with the service role.
 *
 * Those functions are granted to service_role only, so this is the sole route
 * by which they can be reached — and it is only ever taken after getCallerId()
 * has established who is asking.
 */
export async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`rpc ${fn} failed: HTTP ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// Map a SQL-function error code onto an HTTP status. Every failure returns a
// named error and a non-2xx status — no path silently no-ops.
const STATUS_BY_ERROR: Record<string, number> = {
  // caller is authenticated but not allowed to do this
  not_host: 403,
  not_a_member: 403,
  // target doesn't exist
  room_not_found: 404,
  // request conflicts with current server state
  already_started: 409,
  not_enough_players: 409,
  stale_round: 409,
  already_submitted: 409,
  round_in_progress: 409,
  room_not_active: 409,
  round_expired: 409,
  round_not_started: 409,
  no_words_for_tier: 409,
};

export function statusForError(error: string): number {
  return STATUS_BY_ERROR[error] ?? 400;
}

/**
 * Shared request wrapper: CORS preflight, POST-only, authenticated caller,
 * parsed JSON body, and uniform error shaping.
 */
export function handler(
  fn: (body: Record<string, unknown>, callerId: string) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return fail("method_not_allowed", 405);

    const callerId = await getCallerId(req);
    if (!callerId) return fail("unauthorized", 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return fail("invalid_json_body", 400);
    }

    try {
      return await fn(body, callerId);
    } catch (e) {
      // Unexpected failure (e.g. the RPC itself errored). Surface it as a real
      // 500 with a message rather than pretending the call succeeded.
      return fail("internal_error", 500, { detail: e instanceof Error ? e.message : String(e) });
    }
  };
}

/** Shape a SQL-function result into an HTTP response. */
export function respond(result: unknown): Response {
  const r = result as { ok?: boolean; error?: string };
  if (r?.ok === false && typeof r.error === "string") {
    return json(r, statusForError(r.error));
  }
  return json(r ?? { ok: false, error: "empty_result" }, r ? 200 : 500);
}
