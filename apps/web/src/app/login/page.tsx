'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Button, Field, Notice, inputClass } from '@/components/ui';
import { getSupabaseClient } from '@/lib/supabase/client';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [status, setStatus] = useState<{ tone: 'info' | 'error'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);

    const supabase = getSupabaseClient();

    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setStatus({
          tone: 'info',
          message: 'Check your email to confirm the address, then sign in.',
        });
        setMode('signin');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push(next);
        router.refresh();
      }
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'That did not work. Try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5 py-10">
      <header className="mb-8">
        <h1 className="font-display text-4xl font-extrabold tracking-[-0.04em]">Tagged</h1>
        <p className="mt-2 text-sm text-mute">
          Photograph a garment. Get a finished listing everywhere you sell.
        </p>
      </header>

      {/* Someone landing here from a phone QR scan needs to know why they are
          being asked to sign in rather than going straight to the camera. */}
      {next.startsWith('/capture/') ? (
        <div className="mb-5">
          <Notice tone="info" title="Almost there">
            Sign in on this phone once and it will pair with your computer straight away next time.
          </Notice>
        </div>
      ) : null}

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Email">
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            placeholder="you@example.com"
          />
        </Field>

        <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters.' : undefined}>
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        </Field>

        {status ? <Notice tone={status.tone}>{status.message}</Notice> : null}

        <Button type="submit" disabled={busy} full>
          {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </Button>
      </form>

      <button
        type="button"
        onClick={() => {
          setMode(mode === 'signin' ? 'signup' : 'signin');
          setStatus(null);
        }}
        className="mt-5 text-center text-sm text-mute hover:text-ink"
      >
        {mode === 'signin' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
      </button>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
