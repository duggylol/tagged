const LABELS = { poshmark: 'Poshmark', mercari: 'Mercari', depop: 'Depop' };

async function render() {
  const status = await chrome.runtime.sendMessage({ type: 'tagged:status' });

  document.getElementById('sessions').innerHTML = Object.entries(status.sessions ?? {})
    .map(
      ([platform, live]) =>
        `<li><span>${LABELS[platform] ?? platform}</span>` +
        `<span class="state ${live ? 'on' : 'off'}">${live ? 'signed in' : 'signed out'}</span></li>`,
    )
    .join('');

  document.getElementById('apiBase').value = status.apiBase ?? '';
  document.getElementById('meta').textContent =
    `${status.actionsToday} of ${status.dailyCap} actions today. ` +
    `Tagged never stores a marketplace password — it uses the session already in this browser.`;
}

document.getElementById('poll').addEventListener('click', async () => {
  const button = document.getElementById('poll');
  button.textContent = 'Checking…';
  await chrome.runtime.sendMessage({ type: 'tagged:poll-now' });
  button.textContent = 'Check for work now';
  await render();
});

document.getElementById('apiBase').addEventListener('change', async (event) => {
  await chrome.storage.local.set({ apiBase: event.target.value.replace(/\/+$/, '') });
});

void render();
