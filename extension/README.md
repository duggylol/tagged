# Tagged browser extension

The bridge to the marketplaces that have no public API.

## Install for development

1. `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select this `extension/` folder
4. Open the popup and set the server URL (default `http://localhost:3000`)

The extension authenticates to Tagged with the same Supabase session cookie the web app uses, so **sign in to Tagged in the same browser first**.

## What works and what does not

| Piece | State |
|---|---|
| Service worker: polling, claiming, pacing, reporting | Complete |
| Command protocol between worker and adapters | Complete |
| Sold-page scraping shape | Complete |
| Poshmark adapter — publish / end / price / sold / share | Framework complete, **selectors are placeholders** |
| Mercari, Depop adapters | Stubs |

`src/adapters/poshmark.js` will not work as shipped. The `SELECTORS` map at the top is guesswork — Poshmark's class names are generated and change without notice. Filling it in against the live site is real work, and keeping it filled in is ongoing maintenance. That cost is the whole reason this tier of marketplace is Phase 4 rather than free.

Everything *around* the selectors is done and identical across marketplaces, so adding Mercari means writing one `SELECTORS` map and the handful of URL shapes — not a new integration.

## Filling in selectors

Open the marketplace, do the action by hand with DevTools open, and record the stable hooks. Prefer, in order:

1. `[data-test="..."]` / `[data-testid="..."]` — usually survives redesigns
2. `input[name="..."]` — stable on real forms
3. Structural selectors — last resort, breaks first

Note that React ignores a plain `element.value = x`. `setNativeValue()` in `poshmark.js` sets through the native property descriptor and dispatches the events the framework listens for; use it rather than assigning directly.

## Safety rules — do not relax these

These are why the extension is defensible, not performance settings:

- **No credentials, ever.** The extension borrows the session cookie the browser already has. It must never read, store or transmit a marketplace password.
- **Human pace.** Randomized 2.4–6.8 second delays between actions, with hourly and daily caps served by the server (`EXTENSION_PACING`). A burst of activity is what gets accounts flagged.
- **The seller's own account only.** Never read another seller's closet, listings or data.
- **User-initiated.** The queue only contains work someone started in the app. The extension never decides to act on its own.

Automating a logged-in session sits in a grey area of most marketplace terms of service. Every incumbent in this category does it, and Poshmark in particular has pushed back on tools before. The mitigations above are what keep a user's account safe — and the app is architected so that losing one marketplace degrades a feature rather than breaking the product.

## Publishing

Chrome Web Store developer registration is $5, one time. Firefox is free and the same MV3 bundle works with minor manifest tweaks.
