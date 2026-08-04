# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Static one-page marketing site for **Mime Travel**, a travel agency (flights, cruises, hotels, car rentals). The entire site is a single self-contained file: [index.html](index.html) — no build step, no package manager, no framework. CSS is inline in a `<style>` block and JS is inline in a `<script>` block at the end of the file.

## Working with this repo

- There is no build/lint/test tooling — edit `index.html` directly.
- To preview locally, open `index.html` in a browser, or serve it with any static file server (e.g. the VSCode "Live Server" extension, or `python -m http.server`).
- Fonts (Fraunces + Inter) load from Google Fonts CDN; destination/experience photos are hotlinked from Unsplash as placeholders — swap for real assets when available.
- Sanity-check edits with a quick balanced-tag check before considering a change done, since there's no linter to catch structural HTML mistakes:
  ```bash
  node -e "const h=require('fs').readFileSync('index.html','utf8'); ['section','div','form'].forEach(t=>console.log(t,(h.match(new RegExp('<'+t+'[ >]','g'))||[]).length,(h.match(new RegExp('</'+t+'>','g'))||[]).length))"
  ```

## Auto-commit hook (important — affects git history you'll see)

`.claude/settings.json` (gitignored, local-only) defines a `PostToolUse` hook on `Write|Edit` that automatically runs `git add` + `git commit` + `git push origin HEAD` after **every** file edit. This means:
- Commits titled `Auto-commit: update <file>` in `git log` were made automatically by this hook, not manually.
- Every edit is immediately pushed to `origin/main` — there is no local-only staging area to review before it goes live.
- Because `.claude/` is gitignored, this hook only exists on machines where it's been set up locally; don't assume it's active everywhere.

## Deployment

- Hosted on **GitHub Pages**, served from the `main` branch root.
- Custom domain: `mimetravel.com`, set via the [CNAME](CNAME) file (required by GitHub Pages) and DNS records at Cloudflare (proxied — 4 `A` records to GitHub Pages IPs + a `CNAME` for `www`).
- Since DNS is proxied through Cloudflare, cache changes can lag behind a push — allow a few minutes for Cloudflare's edge cache to reflect new commits.

## Page structure (in `index.html`, top to bottom)

Header (fixed, transparent → solid on scroll) → Hero (with a demo "search" form) → Servicios (flights/cruises/hotels/car rental) → Destinos destacados (destination cards) → "Why Mime Travel" trust points → Experiencias (category mosaic) → Testimonios → Newsletter signup → Footer.

Design tokens (colors, fonts) are defined as CSS custom properties in `:root` — reuse these instead of hardcoding new colors:
- `--primary` (#1B3A5C), `--coral` (#FF7A59, CTA color), `--arena` (#F5E6D3), `--turquesa` (#5FBFB3), `--dark`, `--light`
- `--font-display` (Fraunces, for headings), `--font-body` (Inter)

## Forms

Both forms (hero search bar, newsletter) submit via `fetch` to FormSubmit's AJAX endpoint (`https://formsubmit.co/ajax/contacto@mimetravel.com`) — see the `sendToFormSubmit()` helper near the end of the `<script>` block. No backend of our own. Note: `contacto@mimetravel.com` requires Cloudflare Email Routing (or similar) to actually be a deliverable inbox — it doesn't come from GitHub Pages.
