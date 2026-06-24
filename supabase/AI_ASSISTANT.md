# Hustlr AI — setup & operations

An in-app AI assistant ("Hustlr AI") that understands the whole GoHustlr platform and
can actually *do* things on the user's behalf: find gigs, recommend work tailored to
their skills, **post a gig from a spoken/typed description**, book gigs, check their
activity, and update their profile. Works on **web** (floating ✨ button, voice via the
browser) and **mobile** (floating ✨ button, voice via the keyboard mic).

It runs a Claude (Opus 4.8) tool-use loop **server-side** in a Supabase Edge Function —
the Anthropic API key must never ship inside the app or website. Every tool the model
runs executes against Supabase **using the signed-in user's JWT**, so the assistant is
bound by exactly the same Row-Level Security as the rest of the app: it can only see and
do what that user could do by hand.

## One-time setup

1. **Deploy the edge function:**
   ```bash
   supabase functions deploy assistant
   ```

2. **Set the Anthropic API key secret** (get one at https://console.anthropic.com):
   ```bash
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   ```
   Until it's set, the assistant returns a clear `assistant_unconfigured` message
   instead of failing silently.

That's it — no database migration is required. The assistant reads and writes the
existing `jobs`, `job_slots`, `job_requirements`, `bookings`, and `profiles` tables.
(`instant_book` is used opportunistically if the competitive-features migration has been
run, and ignored otherwise.)

## How it works

- The client keeps a running chat transcript and POSTs it to the `assistant` function
  with the user's bearer token.
- The function validates the token, builds a Supabase client scoped to that JWT, then
  runs a Claude tool-use loop (capped at 8 tool rounds) until the model produces a final
  reply. It returns `{ reply, actions }`.
- `actions` (e.g. `gig_created`, `gig_booked`, `profile_updated`) tell the client which
  slices of state to refresh, so the UI updates immediately after the assistant acts.

### Tools the model can call

| Tool | What it does |
|---|---|
| `search_gigs` | Filtered search over open gigs (query, category, pay, location, urgency). |
| `recommend_gigs` | Personalized picks scored by the user's skills + the categories they've worked. |
| `get_gig_details` | Full detail for one gig: slots, poster trust, recent reviews. |
| `create_gig` | Posts a new gig (title/category/pay/location/description/slots/requirements). The voice-to-text path — the user describes a job, the model structures it. Confirms before posting. |
| `book_gig` | Books/applies to a gig (with optional counter-offer); honors instant-book. Confirms before booking. |
| `get_my_activity` | The user's booked gigs, posted gigs, and stats (earnings, rating, XP). |
| `update_profile` | Sets skills, role, city, bio, or weekly goals. |

Reads/writes are RLS-constrained, so e.g. `book_gig` can't book someone else's account
and `create_gig` can only post as the signed-in user.

### Model & cost

- Model: `claude-opus-4-8`, non-streaming, `max_tokens` 2048 per turn.
- Each user message is one Messages API request per tool round (≤ 8). Typical turns are
  1–3 rounds. Cost scales with usage; monitor in the Anthropic console.

### Voice

- **Web:** the mic button uses the browser's Web Speech API (`SpeechRecognition`). It is
  shown only where supported (Chrome/Edge/Safari); elsewhere users type.
- **Mobile:** the device keyboard's dictation mic feeds speech-to-text straight into the
  composer — no extra dependency.

### Safety & limits

- **RLS-bound:** all tool reads/writes use the caller's JWT, so the assistant can
  never exceed what that user could do by hand.
- **Untrusted content:** gig/review text written by other users is treated as data,
  not instructions (the system prompt forbids following directions embedded in it) —
  mitigating indirect prompt injection.
- **Per-request write caps:** at most 3 `create_gig` and 3 `book_gig` writes per
  request, and the tool loop is capped (8 rounds + 1 forced wrap-up) to bound cost.
- **Not yet added — cross-request rate limiting.** There's no per-user request quota
  across requests; a scripted authenticated caller could still run up Anthropic spend.
  For production, add a per-user token-bucket (a small Supabase table or Upstash/KV
  checked before the loop) and monitor spend in the Anthropic console. Supabase's
  platform gateway also applies coarse infra-level limits.

## Future enhancements

- **Per-user rate limiting** (token-bucket keyed on `user.id`) — recommended before
  heavy production traffic.
- **Streaming replies** (SSE pass-through) for token-by-token output.
- **Messaging tool** so the assistant can draft/send chat messages to a poster/earner.
- **Persisted conversations** (store transcripts in a `assistant_threads` table).
- Upgrade to a richer toolset (amendments, disputes, tips) as those flows stabilize.
