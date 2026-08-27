/**
 * depop adapter (content script).
 *
 * Stub. Copy the structure from poshmark.js: same message protocol, same
 * pacing, same DOM helpers — only the SELECTORS map and the URL shapes differ.
 * That is the payoff of the adapter pattern; the framework is written once.
 *
 * Fill in against the live site. Marketplace DOM is not a public interface and
 * these change without notice, so expect to re-check them.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'tagged:execute') return false;
  sendResponse({
    ok: false,
    error: 'The depop adapter is not implemented yet — see extension/README.md.',
  });
  return true;
});
