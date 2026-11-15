# KOVA LIVE — Supabase setup

Everything the KOVA LIVE Phase 1 backend needs on the Supabase side.
The Rust client (`app/src-tauri/src/live.rs`, `SupabaseBackend`) is
already built against this schema — run this setup against the new
project before the first live-project test.

## Contents

| File | What it is |
| --- | --- |
| `setup.sql` | The 8 tables, indexes, RLS policies, the on-signup trigger, the message-pruning trigger, and the Realtime publication entry. Idempotent — safe to re-run. |
| `functions/delete-account/index.ts` | Edge Function: full account deletion (app rows + 30-day tag hold + Auth user). See its README for deploy + secrets. |

## Deploy order

```sh
# 1. Create the project (Free tier) in the Supabase Dashboard.
#    Note the project URL + anon key for the app's live-config.json.

# 2. Apply the schema — Dashboard SQL Editor: paste setup.sql, Run.
#    Or with psql (connection string from Project Settings -> Database):
psql "$DATABASE_URL" -f supabase/setup.sql

# 3. Deploy the Edge Function (from ~/workspace/kova/v1):
supabase link --project-ref <project-ref>
supabase functions deploy delete-account

# 4. Verify (SQL Editor):
#    SELECT tablename, rowsecurity FROM pg_tables
#    WHERE schemaname = 'public'
#      AND tablename IN ('profiles','friend_requests','friendships',
#        'blocks','messages','reports','held_tags','presence');
#    -- every row: rowsecurity = true
#    SELECT tablename FROM pg_publication_tables
#    WHERE pubname = 'supabase_realtime';
#    -- must include public.messages
```

## First live-project test

Point the app at the project (`live-config.json` with the project URL +
anon key, `KOVA_LIVE_BACKEND=supabase`), then: sign up with a tag,
check a taken tag suggests variants, send a friend request from a
second account, accept it, exchange DMs (confirm the Realtime push
arrives), watch presence flip when a game launches, change the tag
(confirm the 30-day rule + old-tag hold), delete the account (confirm
the Auth user is gone and the tag is held).

## Known gaps (see the build report for detail)

- The Rust client sends `on_conflict=...` on its upsert POSTs but no
  `Prefer: resolution=merge-duplicates` header, so PostgREST treats
  them as plain INSERTs (409 on conflict). The presence heartbeat is
  the one this bites: after the first heartbeat inserts the row, every
  follow-up 409s and presence never updates. One-line client fix;
  the schema cannot fix it.
- Server-side message rate limiting (30/min, contract §3) is not
  enforced anywhere yet — the client sends and surfaces a rejection,
  but no DB rule or Edge Function rejects. Enforcing it needs a
  send path the client does not have (an Edge Function in front of
  message inserts). Left unenforced for the closed beta.
- Email confirmation: the client handles both modes (signup returns a
  session when confirmation is off, none when on). Leave the
  project's Auth email confirmation ON (Supabase default) — the app
  has a resend-verification flow.
