'use client';

import { ALL_PLATFORMS, type PlatformId } from '@tagged/core';
import { useEffect, useState } from 'react';

import { Button, Card, Eyebrow, Notice } from '@/components/ui';

/**
 * Marketplace connections.
 *
 * The important thing this screen communicates is the difference between the
 * two connection types, because it changes what the seller can expect:
 *
 *   API platforms work while their computer is off.
 *   Extension platforms only act while their browser is open.
 *
 * Hiding that distinction would make "why didn't my Poshmark listing go up"
 * into a support ticket instead of an obvious answer.
 */

interface Account {
  platform: PlatformId;
  connected: boolean;
  externalUsername: string | null;
  lastSeenAt: string | null;
}

export default function ConnectionsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<PlatformId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch('/api/connections');
    const json = await response.json();
    if (response.ok) setAccounts(json.accounts ?? []);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggleExtension(platform: PlatformId, connected: boolean) {
    setBusy(platform);
    setError(null);
    try {
      const response = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform, connected }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? 'Could not update that.');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update that.');
    } finally {
      setBusy(null);
    }
  }

  const byPlatform = new Map(accounts.map((a) => [a.platform, a]));

  return (
    <div className="max-w-3xl">
      <header className="mb-6">
        <Eyebrow>Connections</Eyebrow>
        <h1 className="text-3xl font-extrabold">Where you sell</h1>
      </header>

      {error ? (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}

      <div className="mb-6">
        <Notice tone="info" title="Two kinds of connection">
          <p className="mb-1.5">
            <strong>Direct</strong> marketplaces connect through their own sign-in. Tagged can list,
            delist and detect sales for you around the clock, even with your computer off.
          </p>
          <p>
            <strong>Extension</strong> marketplaces have no public API. Tagged works them through the
            browser extension, using the session you are already signed in to — it never sees or
            stores a password. They only act while that browser is open.
          </p>
        </Notice>
      </div>

      {loading ? (
        <p className="text-sm text-mute">Loading…</p>
      ) : (
        <div className="space-y-6">
          <section>
            <Eyebrow>Direct connections</Eyebrow>
            <ul className="mt-2 space-y-2.5">
              {ALL_PLATFORMS.filter((s) => s.connection === 'api').map((spec) => {
                const account = byPlatform.get(spec.id);
                return (
                  <Card as="li" key={spec.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-ink">
                          {spec.label}
                          {!spec.enabled ? (
                            <span className="ml-2 rounded bg-sunk px-1.5 py-0.5 font-mono text-[9px] uppercase text-mute">
                              coming later
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-0.5 text-xs text-mute">{spec.notes}</p>
                        {account?.externalUsername ? (
                          <p className="mt-1 font-mono text-xs text-accent">
                            {account.externalUsername}
                          </p>
                        ) : null}
                      </div>

                      <div className="shrink-0">
                        {account?.connected ? (
                          <span className="rounded bg-accent-soft px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-accent">
                            Connected
                          </span>
                        ) : spec.enabled ? (
                          <a href={`/api/oauth/${spec.id}`}>
                            <Button variant="secondary">Connect</Button>
                          </a>
                        ) : null}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </ul>
          </section>

          <section>
            <Eyebrow>Extension connections</Eyebrow>
            <ul className="mt-2 space-y-2.5">
              {ALL_PLATFORMS.filter((s) => s.connection === 'extension').map((spec) => {
                const account = byPlatform.get(spec.id);
                const connected = account?.connected ?? false;

                return (
                  <Card as="li" key={spec.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-ink">
                          {spec.label}
                          {!spec.enabled ? (
                            <span className="ml-2 rounded bg-sunk px-1.5 py-0.5 font-mono text-[9px] uppercase text-mute">
                              coming later
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-0.5 text-xs text-mute">{spec.notes}</p>
                        {connected && account?.lastSeenAt ? (
                          <p className="mt-1 font-mono text-[11px] text-mute">
                            extension last seen {relative(account.lastSeenAt)}
                          </p>
                        ) : null}
                      </div>

                      <div className="shrink-0">
                        {spec.enabled ? (
                          <Button
                            variant={connected ? 'ghost' : 'secondary'}
                            disabled={busy === spec.id}
                            onClick={() => toggleExtension(spec.id, !connected)}
                          >
                            {busy === spec.id ? '…' : connected ? 'Disconnect' : 'Enable'}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </ul>

            <div className="mt-4">
              <Notice tone="warn" title="How Tagged uses the extension">
                <p>
                  Every action is one you started, runs at human pace with randomized delays and a
                  daily cap, and only ever touches your own account. Tagged never scrapes other
                  sellers and never stores a marketplace password. Automating a logged-in session
                  sits in a grey area of most marketplace terms — that pacing is a safety feature for
                  your account standing, not a speed setting.
                </p>
              </Notice>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function relative(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
