# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Static one-page marketing site for **Mime Travel**, a travel agency (flights, cruises, hotels, car rentals). The entire site is a single self-contained file: [index.html](index.html) — no build step, no package manager, no framework. CSS is inline in a `<style>` block and JS is inline in a `<script>` block at the end of the file.

This site is the public front-end for a companion app, **"la expancion"** (`../la expancion`, a separate Expo/React Native + Supabase repo) — the agent/booking backend. Quote requests submitted here land directly in that app's Supabase database and get routed to its agent pool. See "Forms & the la expancion integration" below before touching form submission logic — changes on one side can silently break what agents see on the other.

## Working with this repo

- There is no build/lint/test tooling — edit `index.html` directly.
- To preview locally, open `index.html` in a browser, or serve it with any static file server (e.g. the VSCode "Live Server" extension, or `python -m http.server`).
- Fonts (Fraunces + Inter) load from Google Fonts CDN; destination/experience photos are hotlinked from Unsplash as placeholders — swap for real assets when available. When picking a new Unsplash placeholder, actually view the image before using it — a photo's ID/alt text isn't a guarantee it shows what you think it shows.
- Sanity-check edits with a quick balanced-tag check before considering a change done, since there's no linter to catch structural HTML mistakes:
  ```bash
  node -e "const h=require('fs').readFileSync('index.html','utf8'); ['section','div','form','button'].forEach(t=>console.log(t,(h.match(new RegExp('<'+t+'[ >]','g'))||[]).length,(h.match(new RegExp('</'+t+'>','g'))||[]).length))"
  ```

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

Header (fixed, transparent → solid on scroll, includes a "🎙️ Llamar ahora" call button) → two hidden modals (llamada en vivo / formulario de preventa) → Hero (with a demo "search" form) → Destinos destacados (destination cards, filterable by experience category) → "Why Mime Travel" trust points → Experiencias (category mosaic that drives the destination filter) → Testimonios → Newsletter signup → Footer.

There is no standalone "Servicios" section — it was removed as redundant with the Hero's own search tabs; nav/footer links that used to point at it now point at `#main-content` (the Hero) instead.

Design tokens (colors, fonts) are defined as CSS custom properties in `:root` — reuse these instead of hardcoding new colors:
- `--primary` (#1B3A5C), `--coral` (#FF7A59, CTA color), `--arena` (#F5E6D3), `--turquesa` (#5FBFB3), `--dark`, `--light`
- `--font-display` (Fraunces, for headings), `--font-body` (Inter)

## Forms & the "la expancion" integration

Three forms, three different behaviors:

- **Hero search bar** (`#searchForm`) and **presale modal** (`#presaleForm`, opened by each destination card's "Quiero ir aquí" button) write **directly into the `quote_requests` table** of la expancion's Supabase project, via `@supabase/supabase-js` loaded from a CDN `<script>` tag (client bound to `laExpancion`). `buildSearchQuotePayload()` maps each search tab (vuelos/cruceros/hoteles/autos/paquete) to that table's columns — keep it in sync if la expancion's `quote_requests` schema changes. `createLaExpancionQuoteRequest()` performs the insert, then pings the same `send-request-notification` Edge Function the app itself calls, so agents get the same push notification as if the request had come from inside the app. If the Supabase insert fails for any reason, both forms fall back to the FormSubmit email below so no lead is silently lost.
- **Newsletter form** (`#newsletterForm`) only ever uses FormSubmit — it's a plain mailing-list signup, unrelated to quotes.
- The **FormSubmit fallback**: `sendToFormSubmit()` posts to `https://formsubmit.co/ajax/contacto@mimetravel.com`. Note `contacto@mimetravel.com` requires Cloudflare Email Routing (or similar) to actually be a deliverable inbox — it doesn't come from GitHub Pages.

The Supabase URL/anon key and the notification webhook secret are hardcoded client-side on purpose — they're meant to be public (RLS-protected on the anon-key side; the webhook secret is a low-stakes anti-spam check), the same way they ship inside the mobile app's bundle. A visitor is identified by a random `client_token` UUID stored in `localStorage` (key `la-expancion.client-token`), mirroring the app's own `AsyncStorage`-based device token — the two are **not** shared or synced; each browser/device gets its own.

The **"🎙️ Llamar ahora"** header button is not yet wired to a real call. Today it only requests microphone permission (to test whether the visitor's browser/OS allows it) and then falls back to a phone-callback request form — a real WebRTC connection (mirroring `useVoiceCall` in la expancion) is a separate, not-yet-built integration.

### Destination filtering

Each `.destino-card` carries a `data-categories` attribute (comma-separated from: `aventura`, `relax`, `cultura`, `luna-de-miel`, `naturaleza`), and each `.exp-card` in the Experiencias mosaic carries a matching `data-exp-category`. Clicking an experience scrolls up to Destinos and calls `filterDestinosByCategory()`, which shows/hides cards by matching category. When adding a new destination, give it 1–3 categories that are genuinely distinct from its neighbors — the categories were deliberately rebalanced once already because too much overlap between two categories (e.g. "aventura" and "naturaleza" sharing most of the same cards) made the filter feel broken even though it was working correctly.
