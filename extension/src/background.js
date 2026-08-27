/**
 * Tagged extension — service worker.
 *
 * This is the bridge to the marketplaces that have no public API. It polls the
 * Tagged server for queued commands, hands each one to the right adapter, and
 * reports the outcome back.
 *
 * Design constraints that are safety features, not settings to tune:
 *
 *   • It holds NO marketplace credentials. Every request rides the session
 *     cookie the browser already has because the user is signed in.
 *   • Actions run at human pace with randomized delays, and stop at a daily
 *     cap. Running faster risks the seller's account standing.
 *   • Nothing runs unattended in the sense of acting on its own initiative —
 *     the queue only ever contains work the seller started in the app.
 *
 * Authentication to Tagged itself is the same Supabase session cookie the web
 * app uses, which is why `credentials: 'include'` appears on every call and
 * why the API origin is in host_permissions.
 */

const DEFAULT_API = 'http://localhost:3000';
const POLL_ALARM = 'tagged-poll';
const POLL_MINUTES = 1;

const PLATFORM_HOSTS = {
  poshmark: 'poshmark.com',
  mercari: 'www.mercari.com',
  depop: 'www.depop.com',
};

let pacing = { minDelayMs: 2400, maxDelayMs: 6800, maxActionsPerHour: 120, maxActionsPerDay: 800 };

// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void tick();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'tagged:poll-now') {
    void tick().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'tagged:status') {
    void getStatus().then(sendResponse);
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------

async function apiBase() {
  const { apiBase } = await chrome.storage.local.get('apiBase');
  return apiBase || DEFAULT_API;
}

/** Which marketplaces this browser currently has a live session for. */
async function detectSessions() {
  const sessions = {};
  for (const [platform, host] of Object.entries(PLATFORM_HOSTS)) {
    try {
      const cookies = await chrome.cookies.getAll({ domain: host });
      // Presence of any auth-shaped cookie is a good enough signal. A real
      // check happens when the adapter runs and finds itself logged out.
      sessions[platform] = cookies.some((c) =>
        /session|token|auth|jwt|_ph|sid/i.test(c.name),
      );
    } catch {
      sessions[platform] = false;
    }
  }
  return sessions;
}

async function tick() {
  const base = await apiBase();
  const sessions = await detectSessions();
  const platforms = Object.keys(PLATFORM_HOSTS);

  let payload;
  try {
    const response = await fetch(`${base}/api/extension/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ platforms, sessions, limit: 3 }),
    });

    if (response.status === 401) {
      await setBadge('!', '#9c3a2f');
      return;
    }
    if (!response.ok) return;
    payload = await response.json();
  } catch {
    // Server unreachable — try again on the next alarm rather than retrying
    // in a tight loop.
    return;
  }

  if (payload.pacing) pacing = payload.pacing;

  const commands = payload.commands ?? [];
  if (commands.length === 0) {
    await setBadge('', '#1e6b52');
    return;
  }

  await setBadge(String(commands.length), '#8a6109');

  const results = [];
  for (const command of commands) {
    if (!(await withinDailyCap())) break;
    results.push(await execute(command));
    await sleep(randomDelay());
  }

  if (results.length > 0) {
    await fetch(`${base}/api/extension/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ results }),
    }).catch(() => {});
  }

  await setBadge('', '#1e6b52');
}

/**
 * Run one command by opening the marketplace in a background tab and asking
 * the content script to do the work. The tab is closed afterwards regardless
 * of outcome, so a failure does not leave a pile of windows behind.
 */
async function execute(command) {
  const host = PLATFORM_HOSTS[command.platform];
  if (!host) {
    return { commandId: command.id, ok: false, error: `No adapter for ${command.platform}.` };
  }

  let tab;
  try {
    tab = await chrome.tabs.create({ url: `https://${host}/`, active: false });
    await waitForTabLoad(tab.id);

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'tagged:execute',
      kind: command.kind,
      payload: command.payload,
      pacing,
    });

    return {
      commandId: command.id,
      ok: response?.ok === true,
      externalId: response?.externalId,
      externalUrl: response?.externalUrl,
      error: response?.error,
    };
  } catch (error) {
    return {
      commandId: command.id,
      ok: false,
      error: error?.message ?? 'The extension could not reach that marketplace tab.',
    };
  } finally {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabLoad(tabId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('That marketplace page took too long to load.'));
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Content scripts run at document_idle; give the page a beat to settle.
        setTimeout(resolve, 900);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// --- Pacing -----------------------------------------------------------------

function randomDelay() {
  return Math.round(pacing.minDelayMs + Math.random() * (pacing.maxDelayMs - pacing.minDelayMs));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withinDailyCap() {
  const today = new Date().toISOString().slice(0, 10);
  const { actionLog = {} } = await chrome.storage.local.get('actionLog');
  const count = actionLog[today] ?? 0;

  if (count >= pacing.maxActionsPerDay) return false;

  await chrome.storage.local.set({ actionLog: { [today]: count + 1 } });
  return true;
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color });
}

async function getStatus() {
  const sessions = await detectSessions();
  const base = await apiBase();
  const today = new Date().toISOString().slice(0, 10);
  const { actionLog = {} } = await chrome.storage.local.get('actionLog');

  return {
    apiBase: base,
    sessions,
    actionsToday: actionLog[today] ?? 0,
    dailyCap: pacing.maxActionsPerDay,
  };
}
