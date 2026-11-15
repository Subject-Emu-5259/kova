# delete-account — KOVA LIVE Edge Function

Deletes a KOVA LIVE account completely: the player's app rows (profile,
friendships, friend requests, blocks, messages, reports, presence), a
30-day hold on their tag, and finally the Supabase Auth user itself.

The Rust client (`app/src-tauri/src/live.rs`, `delete_account`) deletes
the app rows itself first and holds the tag, then calls this function
for the one step only the service role can do — deleting the Auth user.
This function re-runs the whole cleanup as a backstop, so rows the
client missed are still removed.

## Deploy

From the repo root (`~/workspace/kova/v1`), with the Supabase CLI
installed and linked to the project:

```sh
supabase link --project-ref <project-ref>
supabase functions deploy delete-account
```

`<project-ref>` is the project id from Dashboard → Project Settings →
General (the subdomain of the project URL, e.g. `abcdefghijklmnop`).

Deploy **with** the default JWT verification — do NOT pass
`--no-verify-jwt`. The client sends the player's user access token, the
gateway verifies it, and the function verifies it again with
`auth.getUser()` before doing anything. An unauthenticated caller gets
401 and nothing is deleted.

## Secrets

None to set by hand on Supabase Cloud. The function reads three
built-in Edge Functions environment variables, all provided by the
runtime:

| Variable | Use |
| --- | --- |
| `SUPABASE_URL` | Project URL (both clients) |
| `SUPABASE_ANON_KEY` | Verifies the caller's JWT |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role client: deletes app rows + the Auth user |

The service-role key bypasses Row Level Security and can delete any
user — it must never be shipped to the app, committed, or pasted
anywhere outside the Supabase Dashboard. If this function is ever
self-hosted, set the three variables with
`supabase secrets set SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=...`.

## Test (after the project exists)

1. Create a throwaway LIVE account in the app, add a friend, send a DM.
2. Delete the account from Settings → KOVA LIVE → Delete my account.
3. In the Dashboard, confirm: the Auth user is gone (Authentication →
   Users), the profile/friendship/message rows are gone (Table Editor),
   and `held_tags` holds the tag_key with `held_until` ~30 days out.
4. Sign up again with the same tag — it must report taken until the
   hold expires.

## Notes

- The function is idempotent: calling it twice for the same user
  succeeds (a missing Auth user counts as already deleted).
- The client ignores this function's response entirely — it signs the
  player out locally either way. A 500 here means the Auth row may
  still exist; check the function logs (Dashboard → Edge Functions →
  delete-account → Logs) and re-run the deletion.
- If the profile row is already gone when the function runs, the tag
  cannot be recovered here (the client's own `held_tags` POST is the
  primary hold). The tag would be freed immediately instead of held.
  That only happens if the client's hold POST failed too — both
  failing together means the client was offline mid-deletion.
