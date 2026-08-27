/**
 * Poshmark adapter (content script).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SELECTORS BELOW ARE PLACEHOLDERS AND WILL NOT WORK AS SHIPPED.
 *
 * Poshmark's DOM is not a public interface — class names are generated and
 * change without notice. Filling in `SELECTORS` against the live site is a
 * genuine half-day of work, and re-checking it is ongoing maintenance. That is
 * the real cost of every marketplace in this tier, and it is why the plan puts
 * the extension in Phase 4 rather than treating it as free.
 *
 * Everything around the selectors — the command protocol, pacing, error
 * reporting, sale scraping — is complete and does not change per marketplace.
 * Adding Mercari or Grailed is filling in one of these files.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SELECTORS = {
  // Sell form
  sellUrl: 'https://poshmark.com/create-listing',
  photoInput: 'input[type="file"]',
  titleInput: '[data-test="listing-title"], input[name="title"]',
  descriptionInput: '[data-test="listing-description"], textarea[name="description"]',
  priceInput: '[data-test="listing-price"], input[name="listingPrice"]',
  originalPriceInput: 'input[name="originalPrice"]',
  submitButton: '[data-test="next-button"], button[type="submit"]',

  // Closet / sold
  soldUrl: 'https://poshmark.com/account/order-list',
  soldRow: '[data-test="order-row"]',
  soldTitle: '[data-test="order-title"]',
  soldPrice: '[data-test="order-price"]',
  soldDate: 'time',
  soldListingLink: 'a[href*="/listing/"]',

  // Listing actions
  editMenuButton: '[data-test="listing-menu"]',
  deleteButton: '[data-test="delete-listing"]',
  confirmDelete: '[data-test="confirm-delete"]',
  shareButton: '[data-test="share-button"]',
  shareToFollowers: '[data-test="share-to-followers"]',
};

const PLATFORM = 'poshmark';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'tagged:execute') return false;

  handle(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));

  return true; // async response
});

async function handle(message) {
  if (!isSignedIn()) {
    return { ok: false, error: 'Not signed in to Poshmark in this browser.' };
  }

  switch (message.kind) {
    case 'publish':
      return publish(message.payload, message.pacing);
    case 'end':
      return endListing(message.payload);
    case 'update_price':
      return updatePrice(message.payload);
    case 'fetch_sold':
      return fetchSold();
    case 'share_closet':
      return shareCloset(message.pacing);
    case 'offer_to_likers':
      return offerToLikers(message.payload);
    default:
      return { ok: false, error: `Unsupported action: ${message.kind}` };
  }
}

// ---------------------------------------------------------------------------

function isSignedIn() {
  // Poshmark redirects signed-out visitors to /login. Cheap, stable check.
  return !location.pathname.startsWith('/login') && !document.querySelector('[data-test="login-form"]');
}

async function publish(payload, pacing) {
  location.assign(SELECTORS.sellUrl);
  await waitForNavigation();

  const form = await waitFor(SELECTORS.titleInput, 15_000);
  if (!form) return { ok: false, error: 'Poshmark listing form did not load.' };

  // Photos first — Poshmark blocks submission until at least one is attached.
  const files = await Promise.all(payload.imageUrls.map(fetchAsFile));
  await attachFiles(SELECTORS.photoInput, files.filter(Boolean));
  await pause(pacing);

  setNativeValue(document.querySelector(SELECTORS.titleInput), payload.title.slice(0, 50));
  setNativeValue(document.querySelector(SELECTORS.descriptionInput), payload.description);
  setNativeValue(document.querySelector(SELECTORS.priceInput), (payload.priceCents / 100).toFixed(0));
  await pause(pacing);

  const submit = document.querySelector(SELECTORS.submitButton);
  if (!submit) return { ok: false, error: 'Could not find the Poshmark submit button.' };
  submit.click();

  await waitForNavigation(20_000);

  // Poshmark lands on /listing/<id> after a successful create.
  const match = location.pathname.match(/\/listing\/([^/?]+)/);
  if (!match) {
    return { ok: false, error: 'Poshmark did not confirm the listing was created.' };
  }

  return {
    ok: true,
    externalId: match[1],
    externalUrl: `https://poshmark.com/listing/${match[1]}`,
  };
}

async function endListing(payload) {
  location.assign(`https://poshmark.com/listing/${payload.externalId}`);
  await waitForNavigation();

  const menu = await waitFor(SELECTORS.editMenuButton, 10_000);
  if (!menu) return { ok: false, error: 'Could not open the listing menu — it may already be gone.' };
  menu.click();

  const del = await waitFor(SELECTORS.deleteButton, 5_000);
  if (!del) return { ok: false, error: 'Could not find the delete control.' };
  del.click();

  const confirm = await waitFor(SELECTORS.confirmDelete, 5_000);
  confirm?.click();

  return { ok: true };
}

async function updatePrice(payload) {
  location.assign(`https://poshmark.com/edit-listing/${payload.externalId}`);
  await waitForNavigation();

  const input = await waitFor(SELECTORS.priceInput, 10_000);
  if (!input) return { ok: false, error: 'Could not find the price field.' };

  setNativeValue(input, (payload.priceCents / 100).toFixed(0));
  document.querySelector(SELECTORS.submitButton)?.click();
  await waitForNavigation(15_000);

  return { ok: true };
}

/**
 * Scrape the seller's OWN order list. This never touches another seller's
 * data — it is the same page they would look at themselves.
 */
async function fetchSold() {
  location.assign(SELECTORS.soldUrl);
  await waitForNavigation();
  await waitFor(SELECTORS.soldRow, 10_000);

  const sold = [...document.querySelectorAll(SELECTORS.soldRow)].map((row) => {
    const link = row.querySelector(SELECTORS.soldListingLink);
    const externalId = link?.getAttribute('href')?.match(/\/listing\/([^/?]+)/)?.[1] ?? '';
    const priceText = row.querySelector(SELECTORS.soldPrice)?.textContent ?? '';
    const dateAttr = row.querySelector(SELECTORS.soldDate)?.getAttribute('datetime');

    return {
      platform: PLATFORM,
      externalId,
      externalOrderId: row.getAttribute('data-order-id') ?? '',
      salePriceCents: Math.round((Number.parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0) * 100),
      soldAt: dateAttr ?? new Date().toISOString(),
    };
  });

  return { ok: true, sold: sold.filter((s) => s.externalId) };
}

/**
 * Sharing the closet drives more Poshmark visibility than any listing copy.
 * Paced deliberately — a burst of shares is what gets accounts flagged.
 */
async function shareCloset(pacing) {
  const buttons = [...document.querySelectorAll(SELECTORS.shareButton)];
  let shared = 0;

  for (const button of buttons) {
    button.click();
    const toFollowers = await waitFor(SELECTORS.shareToFollowers, 3000);
    toFollowers?.click();
    shared += 1;
    await pause(pacing);
  }

  return { ok: true, shared };
}

async function offerToLikers(payload) {
  // Poshmark's offer flow lives behind a modal on the listing page.
  location.assign(`https://poshmark.com/listing/${payload.externalId}`);
  await waitForNavigation();
  return { ok: false, error: 'Offer-to-likers selectors not filled in yet.' };
}

// --- DOM helpers ------------------------------------------------------------

/**
 * React controlled inputs ignore a plain `.value =`. Setting through the
 * native descriptor and dispatching an input event is what actually makes the
 * framework notice.
 */
function setNativeValue(element, value) {
  if (!element) return;
  const setter = Object.getOwnPropertyDescriptor(
    element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function attachFiles(selector, files) {
  const input = document.querySelector(selector);
  if (!input || files.length === 0) return;

  const transfer = new DataTransfer();
  files.forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function fetchAsFile(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return new File([blob], `photo-${crypto.randomUUID().slice(0, 8)}.webp`, { type: blob.type });
  } catch {
    return null;
  }
}

function waitFor(selector, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(found);
      }
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

function waitForNavigation(timeoutMs = 15_000) {
  return new Promise((resolve) => {
    if (document.readyState === 'complete') return setTimeout(resolve, 800);
    window.addEventListener('load', () => setTimeout(resolve, 800), { once: true });
    setTimeout(resolve, timeoutMs);
  });
}

function pause(pacing) {
  const min = pacing?.minDelayMs ?? 2400;
  const max = pacing?.maxDelayMs ?? 6800;
  return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
}
