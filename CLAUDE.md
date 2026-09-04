# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Static one-page marketing site for **Mime Travel**, a travel agency (flights, cruises, hotels, car rentals). The entire site is a single self-contained file: [index.html](index.html) — no build step, no package manager, no framework. CSS is inline in a `<style>` block and JS is inline in a `<script>` block at the end of the file.

The site talks directly to a shared Supabase backend (project `ihrfaprvzdafclquuhlh`) for quote requests, the agent panel (`agente/*.html`), and calls — this repo is self-contained; there is no other repo it depends on. Quote requests submitted from the public site land in that Supabase project's `quote_requests` table and get routed to the agent pool via the pages under `agente/`. See "Forms & the Supabase integration" below before touching form submission logic.

`agente/` is not a small appendix — it's a full second application (agent + owner console) roughly the same size as `index.html`, covering quoting, a WebRTC call center, and payments tracking. See "Agent-side pages" below before assuming the public site is the whole picture.

**Critical gotcha:** most of the backend logic lives in Postgres functions (RPCs) and other Supabase config that are **not tracked in this repo** — only two Edge Functions (`supabase/functions/record-payment-consent`, `supabase/functions/send-web-push`) have their source here. Every `supabaseClient.rpc('some_function', …)` call you find client-side is calling code you cannot see or safely rewrite blind. When a bug or feature needs a change to one of these: (a) ask the user to paste the function's definition (`select pg_get_functiondef(oid) from pg_proc where proname = '...'` in the Supabase SQL Editor — or, for many at once, `select proname, pg_get_functiondef(oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by proname` filtered/paginated with `and proname > '<last seen>' limit 6`, since large pastes truncate), (b) prefer writing a brand-new, additively-named RPC/policy over touching one you've never seen, or (c) if a fix is genuinely simple and low-risk, do a follow-up direct `.update()`/`.insert()` from the client on tables the current user already has RLS rights to (agents can already write several columns on `quote_requests` directly — see `agent_viewing_at`, `quoted_airline`, `price_expires_at` in `agente/panel.html` for the established pattern) rather than guessing at the RPC's body. Always give the user runnable SQL to execute themselves (with `create policy`/`grant execute` as needed) rather than trying to run migrations yourself.

## Working with this repo

- There is no build/lint/test tooling anywhere in the repo (not just `index.html` — this applies equally to every page under `agente/` and to `llamar.html`) — edit files directly.
- To preview locally, open the relevant `.html` file in a browser, or serve it with any static file server (e.g. the VSCode "Live Server" extension, or `python -m http.server`). Pages under `agente/` require a real logged-in Supabase session (with MFA/aal2 — see "Agent-side pages") to get past their own guard, so you can't usefully preview those against production data without agent credentials.
- Fonts (Fraunces + Inter) load from Google Fonts CDN; destination/experience photos are hotlinked from Unsplash as placeholders — swap for real assets when available. When picking a new Unsplash placeholder, actually view the image before using it — a photo's ID/alt text isn't a guarantee it shows what you think it shows.
- Sanity-check edits with a quick balanced-tag check before considering a change done, since there's no linter to catch structural HTML mistakes — run it against whichever file you touched (swap the filename):
  ```bash
  node -e "const h=require('fs').readFileSync('index.html','utf8'); ['section','div','form','button'].forEach(t=>console.log(t,(h.match(new RegExp('<'+t+'[ >]','g'))||[]).length,(h.match(new RegExp('</'+t+'>','g'))||[]).length))"
  ```
- For a syntax check of the inline `<script>` block after an edit (catches unbalanced braces/parens that the tag check won't), extract and parse it rather than eyeballing a multi-thousand-line file:
  ```bash
  node -e "const h=require('fs').readFileSync('index.html','utf8'); const m=[...h.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter(x=>!/\ssrc=/.test(x[1]||'')); m.forEach((x,i)=>{try{new Function(x[2])}catch(e){console.log('script#'+i,e.message)}}); console.log('checked',m.length,'inline scripts')"
  ```
  Note the `\s[^>]*` — a naive `[^>]*` after `<script` will match `src="..."` fragments inside the huge inline script's own string literals and silently skip the real block.

## Auto-commit hook (important — affects git history you'll see)

`.claude/settings.json` (gitignored, local-only) defines a `PostToolUse` hook on `Write|Edit` that automatically runs `git add` + `git commit` + `git push origin HEAD` after **every** file edit. This means:
- Commits titled `Auto-commit: update <file>` in `git log` were made automatically by this hook, not manually.
- Every edit is immediately pushed to `origin/main` — there is no local-only staging area to review before it goes live.
- Because `.claude/` is gitignored, this hook only exists on machines where it's been set up locally; don't assume it's active everywhere.
- The hook only fires on `Write`/`Edit` tool calls — edits made another way (e.g. piping output through a `Bash` command) won't get auto-committed, so check `git status` if you're unsure whether recent work actually made it to `origin/main`.

## Deployment

- Hosted on **GitHub Pages**, served from the `main` branch root.
- Custom domain: `mimetravel.com`, set via the [CNAME](CNAME) file (required by GitHub Pages) and DNS records at Cloudflare (proxied — 4 `A` records to GitHub Pages IPs + a `CNAME` for `www`).
- Since DNS is proxied through Cloudflare, cache changes can lag behind a push — allow a few minutes for Cloudflare's edge cache to reflect new commits.

## Page structure (in `index.html`, top to bottom)

Header (fixed, transparent → solid on scroll) → a hidden modal (formulario de preventa) → Hero (with a demo "search" form) → Destinos destacados (destination cards, filterable by experience category) → "Why Mime Travel" trust points → Experiencias (category mosaic that drives the destination filter) → Testimonios → Newsletter signup → Footer.

There is no standalone "Servicios" section — it was removed as redundant with the Hero's own search tabs; nav/footer links that used to point at it now point at `#main-content` (the Hero) instead.

Design tokens (colors, fonts) are defined as CSS custom properties in `:root` — reuse these instead of hardcoding new colors:
- `--primary` (#1B3A5C), `--coral` (#FF7A59, CTA color), `--arena` (#F5E6D3), `--turquesa` (#5FBFB3), `--dark`, `--light`
- `--font-display` (Fraunces, for headings), `--font-body` (Inter)

## Forms & the Supabase integration

Three forms, three different behaviors:

- **Hero search bar** (`#searchForm`) and **presale modal** (`#presaleForm`, opened by each destination card's "Quiero ir aquí" button) write **directly into the `quote_requests` table** of the Supabase project, via `@supabase/supabase-js` loaded from a CDN `<script>` tag (client bound to `laExpancion` — the variable name is legacy, the project is just "the backend" now). `buildSearchQuotePayload()` maps each search tab (vuelos/cruceros/hoteles/autos/paquete) to that table's columns — keep it in sync if the `quote_requests` schema changes (migrations for that schema aren't tracked in this repo). `createLaExpancionQuoteRequest()` performs the insert, then pings `send-web-push` (this repo's own Edge Function, `supabase/functions/send-web-push`) so agents get a real browser push notification. If the Supabase insert fails for any reason, both forms fall back to the FormSubmit email below so no lead is silently lost.
- **Newsletter form** (`#newsletterForm`) only ever uses FormSubmit — it's a plain mailing-list signup, unrelated to quotes.
- The **FormSubmit fallback**: `sendToFormSubmit()` posts to `https://formsubmit.co/ajax/contacto@mimetravel.com`. Note `contacto@mimetravel.com` requires Cloudflare Email Routing (or similar) to actually be a deliverable inbox — it doesn't come from GitHub Pages.

The Supabase URL/anon key and the notification webhook secret are hardcoded client-side on purpose — they're meant to be public (RLS-protected on the anon-key side; the webhook secret is a low-stakes anti-spam check). A visitor is identified by a random `client_token` UUID stored in `localStorage` (key `la-expancion.client-token` — legacy key name, kept as-is so existing visitors' tokens don't reset).

There **is** an in-browser call button (`llamar.html`, WebRTC signaled over Supabase Realtime, `webrtcCall.js`) — a "📞 Llamar a un agente" link in the header checks camera/mic access first, then hands off to `llamar.html`. This is a real, active feature (not the earlier placeholder attempt that was removed and later rebuilt from scratch). Calling now works in both directions — see "Real-time calls" below.

### Destination filtering

Each `.destino-card` carries a `data-categories` attribute (comma-separated from: `aventura`, `relax`, `cultura`, `luna-de-miel`, `naturaleza`), and each `.exp-card` in the Experiencias mosaic carries a matching `data-exp-category`. Clicking an experience scrolls up to Destinos and calls `filterDestinosByCategory()`, which shows/hides cards by matching category. When adding a new destination, give it 1–3 categories that are genuinely distinct from its neighbors — the categories were deliberately rebalanced once already because too much overlap between two categories (e.g. "aventura" and "naturaleza" sharing most of the same cards) made the filter feel broken even though it was working correctly.

## Agent-side pages (`agente/*.html`)

All of these share the same Supabase project/anon key as `index.html` (hardcoded per-file, not centralized) and the same session guard pattern: check `supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel()` is `'aal2'` and that a user exists, else redirect to `login.html`. `dueno.html` additionally requires `profiles.role === 'super_admin'`, else it bounces to `panel.html` — regular agents can never reach it.

- **`login.html`** — email/password + MFA entry point for everything under `agente/`.
- **`panel.html`** — the main agent workspace: claim/price pending `quote_requests` (flight pricing has its own sub-form for stops/schedule/airline/fare conditions), per-quote chat (`quote_request_messages`, text + photo attachments via the `chat-photos` Storage bucket), reassigning a claimed-but-unanswered quote to another available agent, discarding client-declined quotes, closing a sale, and initiating an outbound call to the quote's client. `agentId`/`agentName` are fetched once at the top of the guard IIFE and reused everywhere below — new features should read from those, not re-query `profiles`.
- **`llamadas.html`** — the call console: shows currently-ringing calls (`get_ringing_calls_for_agent` RPC) with a ringtone, plus a "Llamadas recientes" list (any agent, last 10, any direction) with a one-tap callback. `?outgoing=<call_id>` on load skips straight to the in-call screen as the caller (used when a call was just created elsewhere, e.g. from `panel.html`'s per-quote call button) instead of the normal ring-and-answer flow.
- **`dueno.html`** — owner-only: create new agent accounts (via the `create-agent` Edge Function, not in this repo), team roster with a live "connected now" indicator (`last_active_at` within 90s), a read-only feed of every agent's `quote_requests` (not just the owner's own), and the call log.
- **`pagos.html`** — read-only payments dashboard over `quote_payment_records` + `sale_payment_records` (see "Two parallel sale pipelines" below). Some rows arrive automatically via an external Gmail push webhook that isn't part of this repo — don't assume a row without an obvious insert path in this codebase is a bug.
- **`sw.js` / `presence.js`** — `agente/sw.js` is the agent-facing push service worker (distinct from the root-level `/sw.js` used by public-site visitors — different scope, different audience, keep them separate). `presence.js` is shared by every agent page: a 45s heartbeat that writes `profiles.last_active_at`, plus logic that force-signs-out a `is_available: false` agent if the tab goes to the background (immediately on mobile, after a 5-minute grace period on desktop).

### Two parallel sale pipelines

`quote_requests` (the public-site quoting flow) and `sale_requests` (a separate, simpler direct-sale flow — no public-facing form for it in this repo) are **different tables with mirrored-but-independent RPCs and payment tables** (`quote_payment_records` vs `sale_payment_records`, `confirm_quote_purchase` vs `confirm_sale_purchase`, etc.). Don't assume a fix to one side applies to the other — check which table/RPC family you're actually looking at.

Similarly, there are two unrelated chat systems: `quote_request_messages` (tied to one specific quote, used in `panel.html`/`index.html`'s quote panel) and `chat_threads`/`chat_messages` (a general "Necesito ayuda" support thread keyed only by `client_token`, not tied to any quote). Don't conflate them.

## Real-time calls (WebRTC)

`webrtcCall.js` (repo root) is the one shared signaling module for every call, used by both `llamar.html` (public site) and `agente/llamadas.html` (agents). It signals over a Supabase Realtime broadcast channel named `'call:' + callId` (offer/answer/ICE candidates/hangup), with a public STUN + Metered TURN fallback hardcoded at the top of the file. `isCaller: true` creates the offer and keeps re-sending it until an answer arrives (the callee only subscribes once they actually join); `isCaller: false` waits for an offer and answers it. There is no video-call document-capture feature anymore — it existed once (auto-detect-and-snap a passport/card to the camera mid-call) and was removed because the crops came out unusable in practice; document photos now only ever come from the client's own deliberate upload flow (`quote_requests.client_docs_ready`, delivered live via Realtime broadcast to `panel.html`, never persisted to Storage).

Calls go through the shared `call_requests` table and now work in **both directions**, distinguished by `initiated_by` (`'client'` default, or `'agent'`):
- **Client-calls-agent** (the original flow): `llamar.html` inserts the row and is always `isCaller: true`; any available agent can answer from the ringing-calls list in `llamadas.html`, which then becomes `isCaller: false`.
- **Agent-calls-client**: `panel.html`'s per-quote call button (or `llamadas.html`'s "Llamadas recientes" callback) inserts the row itself with `initiated_by: 'agent'` and `accepted_by` already set to itself, becoming `isCaller: true` via `?outgoing=`. The client side is notified through `pollIncomingAgentCalls()` in `index.html` (a foreground poll while the client is browsing any page of the site) and/or a push notification; either path lands the client on `llamar.html?incoming=<call_id>`, which shows an accept/decline choice screen and joins as `isCaller: false` on accept.

## Push notifications

Two separate, unrelated subscription systems, both routed through the single Edge Function `supabase/functions/send-web-push` (source in this repo — but a code change here needs a manual `supabase functions deploy send-web-push`, it does **not** deploy on push to GitHub):
- **Agents** — `agent_push_subscriptions`, keyed by the logged-in `agent_id`; registered from the "Notificaciones" card in `panel.html`, served by `agente/sw.js`. Sending with no `agentId` broadcasts to every currently-`is_available` agent (used for unclaimed quotes/inbound calls); sending with an `agentId` targets one agent and falls back to the broadcast pool if that agent has no live subscription.
- **Clients** — `client_push_subscriptions`, keyed by the anonymous `client_token` (no login exists for clients). Registered by `subscribeClientPush()` in `index.html`, fired the moment a client's quote panel opens (i.e. right after they submit a quote — deliberately not on page load, to avoid a cold, contextless permission prompt) and served by the root-level `/sw.js`. Sending with a `clientToken` (instead of `agentId`) in the `send-web-push` request body routes down this path.

Both VAPID keys/webhook secret are the same hardcoded pair reused across every page that sends or receives push — there's only one push identity for the whole project, not one per role. iOS Safari will not deliver push at all unless the site has been added to the home screen first (`manifest.json` + the `icon-*.png`/`apple-touch-icon.png` files exist for this); there is no code-level workaround for that.
