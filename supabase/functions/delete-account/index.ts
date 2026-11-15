// KOVA LIVE — delete-account Edge Function
//
// The Rust client (`app/src-tauri/src/live.rs`, `delete_account`) deletes
// the player's app rows itself over PostgREST and holds the tag for 30 days,
// then calls this function to do the one thing only the service role can:
// delete the Auth user. This function is also the backstop — it re-runs the
// whole cleanup with the service key (bypassing RLS), so a row the client
// missed (offline retry, partial failure) is still removed.
//
// Flow:
//   1. Identify the caller from their JWT (the client sends its user access
//      token as the Authorization Bearer token). No valid JWT -> 401.
//   2. Read the caller's profile row for the tag_key and hold it in
//      held_tags for 30 days (spec §7.4). If the client already deleted
//      the profile, the tag is unknowable here and the client's own
//      held_tags POST is the hold — this step is skipped, not an error.
//   3. Delete every app row touching the user, both directions:
//      messages (sent AND received), friendships, friend requests,
//      blocks, reports filed, presence, profile.
//   4. Delete the Auth user via the Admin API. Idempotent: if the user
//      is already gone (double-invoke), that counts as success.
//
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
// all come from the Edge Functions runtime environment — they are built-in
// variables on Supabase Cloud, never hardcoded here and never in the repo.
// The service-role key is the only credential that can delete Auth users;
// it must never be shipped to the app or exposed to the client.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TAG_HOLD_DAYS = 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Preflight (the Tauri client does not send one, but browsers do if
  // this is ever called from a web context).
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error("delete-account: missing SUPABASE_* env vars");
    return json({ error: "server_misconfigured" }, 500);
  }

  // 1. Who is calling? Verify the user's JWT with the anon-key client.
  const authHeader = req.headers.get("Authorization") ?? "";
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const {
    data: { user },
    error: userError,
  } = await caller.auth.getUser();
  if (userError || !user) {
    return json({ error: "unauthorized" }, 401);
  }
  const userId = user.id;

  // Service-role client: bypasses RLS for the cleanup below.
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 2. Hold the tag for 30 days (backstop for the client's own POST).
  const { data: profile } = await admin
    .from("profiles")
    .select("tag_key")
    .eq("user_id", userId)
    .maybeSingle();
  if (profile?.tag_key) {
    const heldUntil = new Date(
      Date.now() + TAG_HOLD_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { error: holdError } = await admin.from("held_tags").upsert(
      { tag_key: profile.tag_key, held_until: heldUntil, held_by: userId },
      { onConflict: "tag_key" },
    );
    if (holdError) {
      // The client's own hold POST is the primary mechanism; log and
      // continue — a failed backstop hold must not block deletion.
      console.error("delete-account: tag hold failed", holdError.message);
    }
  }

  // 3. Delete every app row touching the user. The client already deleted
  // most of these; deleting a non-existent row is a no-op, so this is
  // safe to run unconditionally.
  const { error: messagesError } = await admin
    .from("messages")
    .delete()
    .or(`from_user.eq.${userId},to_user.eq.${userId}`);
  if (messagesError) console.error("delete-account: messages", messagesError.message);

  const { error: friendshipsError } = await admin
    .from("friendships")
    .delete()
    .or(`user_a.eq.${userId},user_b.eq.${userId}`);
  if (friendshipsError) console.error("delete-account: friendships", friendshipsError.message);

  const { error: requestsError } = await admin
    .from("friend_requests")
    .delete()
    .or(`from_user.eq.${userId},to_user.eq.${userId}`);
  if (requestsError) console.error("delete-account: friend_requests", requestsError.message);

  const { error: blocksError } = await admin
    .from("blocks")
    .delete()
    .or(`blocker.eq.${userId},blocked.eq.${userId}`);
  if (blocksError) console.error("delete-account: blocks", blocksError.message);

  const { error: reportsError } = await admin
    .from("reports")
    .delete()
    .eq("reporter", userId);
  if (reportsError) console.error("delete-account: reports", reportsError.message);

  const { error: presenceError } = await admin
    .from("presence")
    .delete()
    .eq("user_id", userId);
  if (presenceError) console.error("delete-account: presence", presenceError.message);

  const { error: profileError } = await admin
    .from("profiles")
    .delete()
    .eq("user_id", userId);
  if (profileError) console.error("delete-account: profiles", profileError.message);

  // 4. Delete the Auth user. This is the step only the service role can
  // do — and the one that matters most: if it fails, report it.
  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) {
    const alreadyGone =
      deleteError.status === 404 ||
      deleteError.message.toLowerCase().includes("not found");
    if (!alreadyGone) {
      console.error("delete-account: auth delete failed", deleteError.message);
      return json(
        { error: "auth_delete_failed", detail: deleteError.message },
        500,
      );
    }
  }

  return json({ ok: true }, 200);
});
