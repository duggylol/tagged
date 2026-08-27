# Tagged

Photograph a garment on your phone. It appears on your computer, the AI identifies it, prices it against real comps, writes the listing for every marketplace you sell on, and takes it down everywhere the moment it sells.

Built to run for about **$31 to launch** and **$0–5/month** at small scale.

---

## Quick start

```bash
npm install
```

Then create a Supabase project (free tier) and run the two migrations in `supabase/migrations/` — either through the SQL editor in the dashboard, or with the CLI:

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Copy the environment template and fill it in:

```bash
cp .env.example apps/web/.env.local
```

You need three values to start: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API), plus a `GEMINI_API_KEY` from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

```bash
npm run dev
```

Open http://localhost:3000, create an account, and go to **Capture**.

---

## Getting phone → PC working

This is the part with a setup trap, so it is worth doing deliberately.

Your phone cannot reach `localhost`, and browsers block the camera on plain HTTP. Two options:

**Fastest — a tunnel** (gives you HTTPS, which the camera needs):

```bash
npx localtunnel --port 3000
```

Set `NEXT_PUBLIC_APP_URL` to the tunnel URL, restart the dev server, and scan the QR.

**LAN only** (works for the file-picker fallback, not the live viewfinder):

```bash
npm run dev:lan --workspace=@tagged/web
```

Set `NEXT_PUBLIC_APP_URL=http://192.168.x.x:3000` using your machine's LAN address.

Once deployed to any HTTPS host, none of this applies — scan and go.

### How the flow works

1. Desktop opens **Capture** → server mints a six-character session code → QR rendered.
2. Phone scans, signs in once, joins the session.
3. Each shot is downscaled, converted to WebP and hashed **in the browser**, then uploaded straight to storage. A 4MB photo becomes ~120KB, so it survives bad signal — and costs you nothing in server bandwidth.
4. The desktop is subscribed to the same rows over Supabase Realtime, so photos appear within a second.
5. Tapping **Next item** on the phone groups those photos into an item and fires the AI pipeline in the background. The phone returns immediately so you can start on the next garment.
6. The desktop watches the item's `analysis_status` move through *reading the photos → finding the product → checking comps → writing the listing*, then offers **Review and publish**.

---

## Repository layout

```
packages/core/          Domain logic. No DOM, no Node, no framework.
  types.ts              Every domain type
  platforms.ts          Marketplace registry + fee schedules
  fees.ts               Net proceeds, sourcing ceilings
  pricing.ts            Comp statistics, price drops
  listing-adapters.ts   Neutral listing → per-marketplace shape
  state-machine.ts      Item lifecycle, delist and relist planning
  analytics.ts          Dashboard metrics, sourcing suggestions, tax export
  capture.ts            Pairing codes, photo grouping, perceptual hashing
  core.test.ts          24 tests over the logic that has to be right

packages/ai/            Model access behind one interface
  provider.ts           LLMProvider + rate card
  gemini.ts             Google, over REST (runs on edge runtimes)
  anthropic.ts          Claude, over the official SDK
  router.ts             Per-task provider selection + retry
  prompts.ts            Extraction and copywriting prompts
  schemas.ts            JSON schema shared by both providers
  normalize.ts          Coerce model output; fail soft

packages/marketplaces/  One interface over every selling channel
  adapter.ts            MarketplaceAdapter
  ebay.ts               OAuth, three-step Inventory publish, Browse comps
  etsy.ts               OAuth (PKCE), listings, receipt polling
  extension.ts          Command queue for the API-less marketplaces

apps/web/               Next.js PWA — mobile-first, desktop-equal
extension/              Chrome MV3 extension
supabase/migrations/    Schema + row-level security
```

**The `packages/core` boundary is load-bearing.** Nothing in it imports Node, the DOM, Next.js, or Supabase — which is what lets the same pricing engine and state machine run unchanged in a Capacitor iOS/Android bundle later. If something there needs `window` or `process`, it belongs in `apps/web/src/lib/platform/` instead.

---

## The AI pipeline

Five stages, two model calls, roughly **$0.0033 per item** — about $3.30 per thousand listings.

| Stage | What happens | Cost |
|---|---|---|
| 0 | Downscale, WebP, perceptual hash — **in the browser** | $0 |
| 1 | One vision call into a strict JSON schema | ~$0.0017 |
| 2 | Vector search over our own comps + eBay Browse | $0 |
| 3 | Median, IQR, days-to-sale — statistics, not inference | $0 |
| 4 | One copy call, then deterministic per-platform adaptation | ~$0.0016 |

> **Correction on the original estimate.** The plan quoted ~$0.001/item on
> `gemini-2.5-flash-lite` ($0.10/$0.40 per 1M). Google has since closed that
> model to new API keys — a fresh key gets a 404 pointing at the 3.x line. The
> cheapest model a new key can reach is `gemini-3.1-flash-lite` at
> $0.25/$1.50, which is where the $0.0033 comes from. Still cheap enough that
> a $14.99 subscriber listing 300 items costs about a dollar a month in AI,
> but it is three times the original figure and the plan overstated it.

Two things drive most of that efficiency. **The care tag photo is the highest-signal frame in the app** — a style number turns a guess into an exact lookup — so `selectPhotosForAnalysis` always sends it first. And **per-platform adaptation happens in code**, not in five more model calls, which cuts cost roughly fivefold and makes title truncation a testable bug rather than a bad sample.

### Changing models

`AI_VISION_PROVIDER` / `AI_COPY_PROVIDER` accept `gemini` or `anthropic`. They are separate settings on purpose: extraction is high-volume and rewards the cheapest model that reads a crumpled care tag; copy is low-volume and rewards a better one. Running Flash-Lite for extraction and Haiku for copy is a sensible production setup.

> **Do not run customer photos through Google's free tier.** It has historically permitted the data to be used to improve their products. Fine for your own development; not fine for other people's inventory. At a dollar per thousand items, pay-as-you-go costs almost nothing and removes the question.

---

## Marketplaces

Two connection types, and the difference is visible to sellers because it changes what they can expect.

| Marketplace | Route | Status |
|---|---|---|
| eBay | Official API | Implemented — needs your dev keys |
| Etsy | Official API | Implemented — needs your dev keys |
| Poshmark | Extension | Framework done, selectors need filling in |
| Mercari | Extension | Stub |
| Depop | Extension | Stub — also apply for their partner Selling API |
| Grailed, Shopify | — | Registered, disabled |

**API platforms** work while the seller's computer is off. **Extension platforms** only act while their browser is open, because there is no other way in — Poshmark publishes no API at all, and Depop's is invite-gated.

### The extension

`extension/src/adapters/poshmark.js` has the complete framework — command protocol, pacing, error reporting, sold-page scraping — with **placeholder selectors that will not work as shipped**. Marketplace DOM is not a public interface; filling those in against the live site is a genuine half-day plus ongoing maintenance. That is the real cost of this tier, and Mercari or Grailed is then one file, not a new integration.

Load it with `chrome://extensions` → Developer mode → *Load unpacked* → the `extension/` folder.

**The safety posture is deliberate and should not be tuned away.** The extension holds no credentials — it borrows the session cookie the browser already has. Actions are user-initiated, run at randomized human pace, and stop at a daily cap. It only ever touches the seller's own account and never scrapes other sellers. Automating a logged-in session sits in a grey area of most marketplace terms; that pacing protects your users' account standing, not your throughput.

---

## Inventory sync

The ordering here is the most important decision in the codebase, and it is not the obvious one.

```
draft → active → sale_detected → delist_pending → awaiting_confirm → sold
                                                        ↓
                                                    relisting
```

When a sale is detected, listings come down from every other marketplace **before** the seller confirms anything. Waiting for confirmation is precisely the window in which a double-sale happens. Ending a listing is fully reversible; a cancellation strike is not.

Nothing is archived and no profit is booked until the seller taps **Confirm** — and if the sale falls through, `planRelist` replays the stored payload snapshot back onto every platform in one tap. That is why `listings.payload_snapshot` exists.

Every marketplace write carries an idempotency key, and `sync_events` is append-only. Both matter for the same reason: the only way to debug "my item disappeared" three days later is to replay exactly what happened.

### Sale detection

| Platform | Mechanism | Latency |
|---|---|---|
| eBay | Order polling / webhooks | Seconds |
| Etsy | Receipt polling | 5–15 min |
| Poshmark, Mercari, Depop | Extension reads the seller's own sold page | Minutes, browser open |

Schedule the cron sweep every five minutes:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/cron/detect-sales
```

A Cloudflare Worker cron trigger does this for free.

---

## Going native

The groundwork is done; the switch is not thrown.

```bash
npm install -D @capacitor/cli @capacitor/core @capacitor/ios @capacitor/android
npm run cap:sync
npx cap add ios      # needs a Mac + Xcode
npx cap add android
```

`BUILD_TARGET=capacitor` produces a static export (see `next.config.mjs`). A static bundle has no server, so set `NEXT_PUBLIC_API_BASE` to your deployed origin — `src/lib/api.ts` routes every call through it.

The camera already uses `getUserMedia` with a file-capture fallback, both of which Capacitor's WebView supports, so the phone capture screen needs no rewrite. Swapping in `@capacitor/camera` later is an optimization, not a prerequisite.

Costs when you get there: $25 one-time for Google Play, $99/year for Apple. Neither is needed to launch — the PWA installs to a home screen today.

---

## Deploying

A Supabase project is already provisioned for this app and both migrations are applied:

- **Project ref:** `ilbanwcmekfaplmffphe` (org: duggy's, free tier, us-east-1)
- **URL:** `https://ilbanwcmekfaplmffphe.supabase.co`
- **Dashboard:** https://supabase.com/dashboard/project/ilbanwcmekfaplmffphe

To deploy to Vercel, run this once from the repo root:

```
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

It signs you in (one browser click), links the project, sets every production
environment variable, deploys, then points `NEXT_PUBLIC_APP_URL` at the live
origin and redeploys. It prompts for exactly two secrets — the Supabase
service-role key and a Gemini API key — which are typed into the Vercel CLI on
your machine and never written to disk.

`vercel.json` pins the monorepo build (`npm run build --workspace=@tagged/web`,
output `apps/web/.next`) and registers the sale-detection cron at five-minute
intervals. Vercel injects `Authorization: Bearer $CRON_SECRET` on cron requests
automatically, which is exactly what `/api/cron/detect-sales` checks for.

After the first deploy, set the Site URL in Supabase so email confirmation
links come back to the right origin:
https://supabase.com/dashboard/project/ilbanwcmekfaplmffphe/auth/url-configuration

Once you add eBay or Etsy credentials, update the redirect URIs in their
developer consoles to match the deployed origin.

## Commands

```bash
npm run dev         # dev server
npm run build       # production build
npm test            # 24 core tests
npm run typecheck   # all packages + the app
npm run db:push     # apply migrations
```

---

## Things to verify before you trust them

- **Fee rates in `packages/core/src/platforms.ts`.** Every schedule carries a `lastVerified` date and a `verifyUrl`. Marketplaces change these with weeks of notice and no API to read them from. Re-check quarterly — you are showing sellers profit numbers.
- **Extension selectors.** They will break. Budget for it.
- **Free-tier limits.** Supabase, Cloudflare and Gemini free tiers are business decisions someone else makes.

## Known gaps

These are scoped but not built:

- Measurement extraction from a reference object, defect auto-detection beyond what the vision prompt already returns, voice notes.
- Background removal is wired as an optional dynamic import (`@imgly/background-removal`) but not surfaced in the UI yet.
- Duplicate detection matches exact perceptual hashes only; near-match needs a Hamming-distance index.
- No billing. Plan tiers exist as a column on `profiles` and nothing enforces them.
- eBay business policies must be set up in Seller Hub and written into `marketplace_accounts.meta` before publishing works — the connect flow points sellers there but does not fetch them automatically yet.
