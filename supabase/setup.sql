-- ============================================================================
-- KOVA LIVE Phase 1 — Supabase setup
-- ============================================================================
-- Creates the eight tables the Rust client (`app/src-tauri/src/live.rs`,
-- `SupabaseBackend`) queries via PostgREST, plus the Row Level Security
-- policies that let the signed-in player do exactly what the client does
-- through the anon key — and nothing more.
--
-- HOW TO APPLY (run once against the new project; safe to re-run):
--   Option A — Supabase Dashboard: SQL Editor -> paste this file -> Run.
--   Option B — psql:  psql "$DATABASE_URL" -f supabase/setup.sql
--     ($DATABASE_URL is the project's Postgres connection string from
--     Dashboard -> Project Settings -> Database. Never commit it.)
-- After this, deploy the delete-account Edge Function (see
-- supabase/functions/delete-account/README.md), then run the first
-- live-project test (sign-up, tag claim, friend request, DM, presence).
--
-- IDEMPOTENCY: tables use CREATE TABLE IF NOT EXISTS, indexes use
-- CREATE INDEX IF NOT EXISTS, policies are dropped before re-creation,
-- the trigger function is CREATE OR REPLACE, triggers are dropped
-- before re-creation, and the Realtime publication entry is guarded by
-- a DO block. Re-running the file is a no-op on an already-set-up
-- project. (Constraint changes to an EXISTING table are not applied by
-- a re-run — this file is the fresh-project setup, not a migration.)
--
-- DESIGN NOTES (read before changing anything):
-- * User ids are Supabase Auth UUIDs (auth.users.id). Every user-id
--   column FKs to auth.users with ON DELETE CASCADE, so deleting the
--   Auth user removes any leftover app rows. Exception: held_tags
--   uses ON DELETE SET NULL — the 30-day tag hold must SURVIVE
--   account deletion (spec §7.4).
-- * `tag_key` is the lowercased trimmed tag (Rust: tag.trim().to_lowercase()).
--   It is a plain column, NOT generated: the client sends it explicitly
--   in INSERT/PATCH bodies, which a generated column would reject.
-- * `tag_changed_at` is NULL until the first tag CHANGE (stub parity:
--   a fresh account has no cooldown; the 30-day clock starts at the
--   first change, not at signup). The signup trigger leaves it NULL.
-- * The client sends `Prefer: resolution=merge-duplicates` on its
--   upsert POSTs (fixed 2026-11-14 in live.rs `rest()` — before that,
--   `on_conflict` alone was ignored by PostgREST and the POSTs 409d
--   on conflict, which would have broken the presence heartbeat).
--   The UPDATE policies below exist so those upserts merge correctly.
-- * RLS policies run as the PostgREST role: `authenticated` when the
--   request carries a user JWT, `anon` when it carries only the anon
--   key. check_tag runs BEFORE sign-in (sign-up flow), so the
--   profiles + held_tags SELECT policies also cover `anon`.
-- * Realtime: the client subscribes ONLY to INSERTs on `messages`
--   (topic realtime:public:messages, filter to_user=eq.<me>). Only
--   `messages` is added to the supabase_realtime publication.
--   Presence travels through the `presence` table, not Realtime.
--
-- RLS POLICY INVENTORY (28 policies; one line each — purpose + Rust call):
--   profiles
--     profiles_select_public      SELECT  anon+auth, any row — public profile fields are
--       world-readable by design (tags are the public identity).
--       Serves: user_id_for_tag, profile_row, get_friends profile batch.
--     profiles_insert_own         INSERT  auth, user_id = auth.uid().
--       Serves: sign_in fallback profile creation (on_conflict=user_id).
--     profiles_update_own         UPDATE  auth, own row only.
--       Serves: claim_tag (tag change), sync_profile, sign_in upsert merge.
--     profiles_delete_own         DELETE  auth, own row only. Serves: delete_account.
--   friend_requests
--     friend_requests_select_party SELECT auth, from_user or to_user = me.
--       Serves: send_request pending check, accept_request lookup,
--       get_friends requests in/out.
--     friend_requests_insert_sender INSERT auth, from_user = me AND not already
--       friends AND not blocked either way. Serves: send_request.
--     friend_requests_update_recipient UPDATE auth, to_user = me AND status
--       pending. Serves: accept_request (pending -> accepted).
--     friend_requests_delete_party DELETE auth, from_user or to_user = me.
--       Serves: decline_request, block (clears requests), delete_account.
--   friendships
--     friendships_select_party    SELECT auth, user_a or user_b = me.
--       Serves: are_friends, friend-cap checks, get_friends.
--     friendships_insert_party    INSERT auth, user_a or user_b = me.
--       Serves: accept_request (canonical order: smaller uuid first).
--     friendships_update_party    UPDATE auth, user_a or user_b = me.
--       Serves: accept_request upsert merge branch.
--     friendships_delete_party    DELETE auth, user_a or user_b = me.
--       Serves: remove_friend, delete_account.
--   blocks
--     blocks_select_party         SELECT auth, blocker or blocked = me.
--       Serves: blocked_either_way, get_friends blocked list.
--     blocks_insert_blocker       INSERT auth, blocker = me. Serves: block.
--     blocks_update_blocker       UPDATE auth, blocker = me.
--       Serves: block upsert merge branch.
--     blocks_delete_party         DELETE auth, blocker or blocked = me.
--       Serves: unblock, delete_account.
--   messages
--     messages_select_party       SELECT auth, from_user or to_user = me.
--       Serves: fetch_messages, fetch_all_messages, delete_message lookup,
--       Realtime INSERT delivery.
--     messages_insert_sender_friend INSERT auth, from_user = me AND friends
--       with the recipient AND not blocked either way. Serves: send_message.
--     messages_delete_sender      DELETE auth, from_user = me (own messages
--       only; deleting removes the message for both sides).
--       Serves: delete_message, delete_account.
--     (No UPDATE policy: messages are never edited.)
--   reports
--     reports_insert_reporter     INSERT auth, reporter = me. Serves: report.
--     reports_delete_reporter     DELETE auth, reporter = me.
--       Serves: delete_account.
--     (No SELECT/UPDATE policies: the client never reads reports; the
--     Avok team reviews them in the Supabase Dashboard, which bypasses RLS.)
--   held_tags
--     held_tags_select_all        SELECT anon+auth, any row — availability
--       checks must see every hold. Serves: check_tag (incl. pre-sign-in).
--     held_tags_insert_holder     INSERT auth, held_by = me.
--       Serves: claim_tag (old tag held 30 days), delete_account.
--     held_tags_update_holder     UPDATE auth, held_by = me.
--       Serves: claim_tag / delete_account upsert merge branch.
--     (No DELETE policy: holds expire by time; the service role prunes.)
--   presence
--     presence_select_self_or_friend SELECT auth, own row or a friend's row.
--       Serves: get_friends presence batch.
--     presence_insert_own         INSERT auth, user_id = me.
--       Serves: set_presence heartbeat.
--     presence_update_own         UPDATE auth, user_id = me.
--       Serves: set_presence heartbeat merge branch.
--     presence_delete_own         DELETE auth, user_id = me.
--       Serves: delete_account.
-- ============================================================================

-- gen_random_uuid() for the id defaults below (pre-enabled on most
-- Supabase projects; harmless if already present).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- TABLES
-- ============================================================================

-- Public profile: the LIVE identity. One row per Auth user, created by
-- the on-signup trigger below (the client sends tag + tag_key in
-- user_metadata at sign-up) or, as a fallback, by the client's sign_in
-- best-effort upsert. Email lives in auth.users, never here.
CREATE TABLE IF NOT EXISTS public.profiles (
    user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
    tag text NOT NULL CHECK (char_length(tag) BETWEEN 3 AND 32),
    tag_key text NOT NULL,
    avatar text NOT NULL DEFAULT '',
    bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 160),
    banner text NOT NULL DEFAULT '',
    -- NULL until the first tag change (see header note).
    tag_changed_at timestamptz
);
-- Case-insensitive tag uniqueness: the client resolves tags through
-- tag_key (user_id_for_tag) and assumes one row per key.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_tag_key_key
    ON public.profiles (tag_key);

-- Pending / accepted friend requests. Declined requests are DELETEd by
-- the client (never status-changed), so `status` only ever holds
-- 'pending' or 'accepted'.
CREATE TABLE IF NOT EXISTS public.friend_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    to_user uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (from_user <> to_user)
);
CREATE INDEX IF NOT EXISTS friend_requests_to_user_status_idx
    ON public.friend_requests (to_user, status);
CREATE INDEX IF NOT EXISTS friend_requests_from_user_status_idx
    ON public.friend_requests (from_user, status);
-- At most one PENDING request per unordered pair (either direction).
-- The client checks before sending; this closes the double-send race,
-- which would otherwise strand a second pending request after the
-- first is accepted. Accepted rows are exempt (a new request after
-- unfriending must be allowed).
CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_pending_pair_key
    ON public.friend_requests
    (LEAST(from_user, to_user), GREATEST(from_user, to_user))
    WHERE status = 'pending';

-- Friend edges. Canonical order: the smaller uuid is user_a (the
-- client canonicalizes in accept_request; the CHECK enforces it so
-- the composite PK actually dedupes).
CREATE TABLE IF NOT EXISTS public.friendships (
    user_a uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    user_b uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
);
CREATE INDEX IF NOT EXISTS friendships_user_b_idx
    ON public.friendships (user_b);

-- Blocks. Blocking also removes the friendship and any pending
-- requests (the client does that); the row itself only records the block.
CREATE TABLE IF NOT EXISTS public.blocks (
    blocker uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    blocked uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    PRIMARY KEY (blocker, blocked),
    CHECK (blocker <> blocked)
);
CREATE INDEX IF NOT EXISTS blocks_blocked_idx
    ON public.blocks (blocked);

-- Direct messages. The client sends only from_user/to_user/body and
-- reads back id + sent_at from the representation, so both default
-- server-side. History is capped at 500 per conversation by the
-- prune trigger below (spec §5.2 / §7.5).
CREATE TABLE IF NOT EXISTS public.messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    to_user uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    sent_at timestamptz NOT NULL DEFAULT now()
);
-- One index per conversation direction (the client's fetch query is
-- or=(and(from=me,to=them),and(from=them,to=me)) ORDER BY sent_at).
CREATE INDEX IF NOT EXISTS messages_from_to_sent_idx
    ON public.messages (from_user, to_user, sent_at);
CREATE INDEX IF NOT EXISTS messages_to_from_sent_idx
    ON public.messages (to_user, from_user, sent_at);
-- Conversation-pair index for the prune trigger below.
CREATE INDEX IF NOT EXISTS messages_pair_sent_idx
    ON public.messages
    ((LEAST(from_user, to_user)), (GREATEST(from_user, to_user)), sent_at DESC);

-- Reports for manual review by the Avok team. The client only
-- INSERTs (and DELETEs its own on account deletion); nothing in the
-- app reads them back. `resolution` is team workflow state
-- ('open' until a team member changes it in the Dashboard).
CREATE TABLE IF NOT EXISTS public.reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('message', 'profile')),
    ref text NOT NULL,
    note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    resolution text NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS reports_reporter_idx
    ON public.reports (reporter);

-- Released tags, held 30 days before anyone else can claim them
-- (spec §2.2 / §7.4). `held_by` is NOT in the Rust header checklist:
-- it exists so the upsert UPDATE policy can scope re-holds to the
-- player who released the tag (without it, any signed-in player
-- could extend anyone else's hold). It defaults to the caller and
-- is SET NULL — never cascaded — when the holder's Auth user is
-- deleted, so the hold survives account deletion.
CREATE TABLE IF NOT EXISTS public.held_tags (
    tag_key text PRIMARY KEY,
    held_until timestamptz NOT NULL,
    held_by uuid DEFAULT auth.uid()
        REFERENCES auth.users (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS held_tags_held_until_idx
    ON public.held_tags (held_until);

-- Live presence: current state only, no history (spec §7.2).
-- `state` is 'online' | 'in_game' | 'offline' (derived client-side
-- from the privacy toggles + playtime watcher); `playing` is the
-- game display name when in game, else NULL.
CREATE TABLE IF NOT EXISTS public.presence (
    user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
    state text NOT NULL CHECK (state IN ('online', 'in_game', 'offline')),
    playing text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.held_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presence ENABLE ROW LEVEL SECURITY;

-- Grants are the first gate (PostgREST roles need table privileges
-- before RLS is even consulted); the policies below do the real
-- authorization. `anon` gets SELECT only on the two tables the
-- pre-sign-in tag check reads (profiles, held_tags).
GRANT SELECT ON public.profiles, public.held_tags TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friend_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friendships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blocks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.held_tags TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.presence TO authenticated;

-- --- profiles ---
DROP POLICY IF EXISTS profiles_select_public ON public.profiles;
CREATE POLICY profiles_select_public ON public.profiles
    FOR SELECT TO anon, authenticated
    USING (true);

DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own ON public.profiles
    FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS profiles_delete_own ON public.profiles;
CREATE POLICY profiles_delete_own ON public.profiles
    FOR DELETE TO authenticated
    USING (user_id = auth.uid());

-- --- friend_requests ---
DROP POLICY IF EXISTS friend_requests_select_party ON public.friend_requests;
CREATE POLICY friend_requests_select_party ON public.friend_requests
    FOR SELECT TO authenticated
    USING (from_user = auth.uid() OR to_user = auth.uid());

DROP POLICY IF EXISTS friend_requests_insert_sender ON public.friend_requests;
CREATE POLICY friend_requests_insert_sender ON public.friend_requests
    FOR INSERT TO authenticated
    WITH CHECK (
        from_user = auth.uid()
        AND NOT EXISTS (
            SELECT 1 FROM public.friendships f
            WHERE (f.user_a = from_user AND f.user_b = to_user)
               OR (f.user_a = to_user AND f.user_b = from_user)
        )
        AND NOT EXISTS (
            SELECT 1 FROM public.blocks b
            WHERE (b.blocker = from_user AND b.blocked = to_user)
               OR (b.blocker = to_user AND b.blocked = from_user)
        )
    );

DROP POLICY IF EXISTS friend_requests_update_recipient ON public.friend_requests;
CREATE POLICY friend_requests_update_recipient ON public.friend_requests
    FOR UPDATE TO authenticated
    USING (to_user = auth.uid() AND status = 'pending')
    WITH CHECK (to_user = auth.uid());

DROP POLICY IF EXISTS friend_requests_delete_party ON public.friend_requests;
CREATE POLICY friend_requests_delete_party ON public.friend_requests
    FOR DELETE TO authenticated
    USING (from_user = auth.uid() OR to_user = auth.uid());

-- --- friendships ---
DROP POLICY IF EXISTS friendships_select_party ON public.friendships;
CREATE POLICY friendships_select_party ON public.friendships
    FOR SELECT TO authenticated
    USING (user_a = auth.uid() OR user_b = auth.uid());

DROP POLICY IF EXISTS friendships_insert_party ON public.friendships;
CREATE POLICY friendships_insert_party ON public.friendships
    FOR INSERT TO authenticated
    WITH CHECK (user_a = auth.uid() OR user_b = auth.uid());

DROP POLICY IF EXISTS friendships_update_party ON public.friendships;
CREATE POLICY friendships_update_party ON public.friendships
    FOR UPDATE TO authenticated
    USING (user_a = auth.uid() OR user_b = auth.uid())
    WITH CHECK (user_a = auth.uid() OR user_b = auth.uid());

DROP POLICY IF EXISTS friendships_delete_party ON public.friendships;
CREATE POLICY friendships_delete_party ON public.friendships
    FOR DELETE TO authenticated
    USING (user_a = auth.uid() OR user_b = auth.uid());

-- --- blocks ---
DROP POLICY IF EXISTS blocks_select_party ON public.blocks;
CREATE POLICY blocks_select_party ON public.blocks
    FOR SELECT TO authenticated
    USING (blocker = auth.uid() OR blocked = auth.uid());

DROP POLICY IF EXISTS blocks_insert_blocker ON public.blocks;
CREATE POLICY blocks_insert_blocker ON public.blocks
    FOR INSERT TO authenticated
    WITH CHECK (blocker = auth.uid());

DROP POLICY IF EXISTS blocks_update_blocker ON public.blocks;
CREATE POLICY blocks_update_blocker ON public.blocks
    FOR UPDATE TO authenticated
    USING (blocker = auth.uid())
    WITH CHECK (blocker = auth.uid());

DROP POLICY IF EXISTS blocks_delete_party ON public.blocks;
CREATE POLICY blocks_delete_party ON public.blocks
    FOR DELETE TO authenticated
    USING (blocker = auth.uid() OR blocked = auth.uid());

-- --- messages ---
DROP POLICY IF EXISTS messages_select_party ON public.messages;
CREATE POLICY messages_select_party ON public.messages
    FOR SELECT TO authenticated
    USING (from_user = auth.uid() OR to_user = auth.uid());

DROP POLICY IF EXISTS messages_insert_sender_friend ON public.messages;
CREATE POLICY messages_insert_sender_friend ON public.messages
    FOR INSERT TO authenticated
    WITH CHECK (
        from_user = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.friendships f
            WHERE (f.user_a = auth.uid() AND f.user_b = to_user)
               OR (f.user_a = to_user AND f.user_b = auth.uid())
        )
        AND NOT EXISTS (
            SELECT 1 FROM public.blocks b
            WHERE (b.blocker = auth.uid() AND b.blocked = to_user)
               OR (b.blocker = to_user AND b.blocked = auth.uid())
        )
    );

DROP POLICY IF EXISTS messages_delete_sender ON public.messages;
CREATE POLICY messages_delete_sender ON public.messages
    FOR DELETE TO authenticated
    USING (from_user = auth.uid());

-- --- reports ---
DROP POLICY IF EXISTS reports_insert_reporter ON public.reports;
CREATE POLICY reports_insert_reporter ON public.reports
    FOR INSERT TO authenticated
    WITH CHECK (reporter = auth.uid());

DROP POLICY IF EXISTS reports_delete_reporter ON public.reports;
CREATE POLICY reports_delete_reporter ON public.reports
    FOR DELETE TO authenticated
    USING (reporter = auth.uid());

-- --- held_tags ---
DROP POLICY IF EXISTS held_tags_select_all ON public.held_tags;
CREATE POLICY held_tags_select_all ON public.held_tags
    FOR SELECT TO anon, authenticated
    USING (true);

DROP POLICY IF EXISTS held_tags_insert_holder ON public.held_tags;
CREATE POLICY held_tags_insert_holder ON public.held_tags
    FOR INSERT TO authenticated
    WITH CHECK (held_by = auth.uid());

DROP POLICY IF EXISTS held_tags_update_holder ON public.held_tags;
CREATE POLICY held_tags_update_holder ON public.held_tags
    FOR UPDATE TO authenticated
    USING (held_by = auth.uid())
    WITH CHECK (held_by = auth.uid());

-- --- presence ---
DROP POLICY IF EXISTS presence_select_self_or_friend ON public.presence;
CREATE POLICY presence_select_self_or_friend ON public.presence
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.friendships f
            WHERE (f.user_a = auth.uid() AND f.user_b = public.presence.user_id)
               OR (f.user_a = public.presence.user_id AND f.user_b = auth.uid())
        )
    );

DROP POLICY IF EXISTS presence_insert_own ON public.presence;
CREATE POLICY presence_insert_own ON public.presence
    FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS presence_update_own ON public.presence;
CREATE POLICY presence_update_own ON public.presence
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS presence_delete_own ON public.presence;
CREATE POLICY presence_delete_own ON public.presence
    FOR DELETE TO authenticated
    USING (user_id = auth.uid());

-- ============================================================================
-- SIGNUP TRIGGER — creates the profiles row from user_metadata
-- ============================================================================
-- The Rust sign_up sends the claimed tag in user_metadata
-- ({ "tag", "tag_key" }) and expects this trigger to create the
-- profiles row. It is NOT in the Rust header checklist's table list,
-- but the sign_up code comment requires it ("the project's on-signup
-- trigger can create the profiles row"). Without it, sign_in's
-- best-effort fallback still creates the row — but only at first
-- sign-in, and only if the metadata survived.
-- If two signups race the same tag, the loser's trigger insert hits
-- the tag_key unique index and the whole signup rolls back — the
-- player retries with another tag. That is the correct outcome.
-- SECURITY DEFINER so the insert bypasses RLS (the trigger fires in
-- the Auth service's context, not the player's).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.raw_user_meta_data ->> 'tag' IS NOT NULL
       AND btrim(NEW.raw_user_meta_data ->> 'tag') <> '' THEN
        INSERT INTO public.profiles
            (user_id, tag, tag_key, avatar, bio, banner)
        VALUES (
            NEW.id,
            btrim(NEW.raw_user_meta_data ->> 'tag'),
            lower(btrim(NEW.raw_user_meta_data ->> 'tag')),
            '', '', ''
        )
        ON CONFLICT (user_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- MESSAGE PRUNING — last 500 per conversation, server-side (spec §5.2/§7.5)
-- ============================================================================
-- The client fetches at most 500 per conversation and its local cache
-- prunes to 500; this trigger is the server half of that rule, so the
-- messages table cannot grow unbounded on the Free tier's 500 MB.
-- SECURITY DEFINER so the prune can remove the conversation partner's
-- old messages too (under the caller's RLS the DELETE policy would
-- only match the sender's own rows).
CREATE OR REPLACE FUNCTION public.prune_old_messages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.messages m
    WHERE (LEAST(m.from_user, m.to_user), GREATEST(m.from_user, m.to_user))
        = (LEAST(NEW.from_user, NEW.to_user), GREATEST(NEW.from_user, NEW.to_user))
      AND m.id NOT IN (
            SELECT m2.id
            FROM public.messages m2
            WHERE (LEAST(m2.from_user, m2.to_user), GREATEST(m2.from_user, m2.to_user))
                = (LEAST(NEW.from_user, NEW.to_user), GREATEST(NEW.from_user, NEW.to_user))
            ORDER BY m2.sent_at DESC, m2.id DESC
            LIMIT 500
        );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prune_messages_after_insert ON public.messages;
CREATE TRIGGER prune_messages_after_insert
    AFTER INSERT ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.prune_old_messages();

-- ============================================================================
-- REALTIME — the client subscribes to INSERTs on messages only
-- ============================================================================
-- Guarded: ALTER PUBLICATION ... ADD TABLE errors if the table is
-- already a member, so check first (keeps the file re-runnable).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
    END IF;
END
$$;

-- ============================================================================
-- DONE. Verify with:
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public' AND tablename IN
--     ('profiles','friend_requests','friendships','blocks','messages',
--      'reports','held_tags','presence');
--   -- every row should read rowsecurity = true.
--   SELECT tablename FROM pg_publication_tables
--   WHERE pubname = 'supabase_realtime';
--   -- must include public.messages.
-- ============================================================================
