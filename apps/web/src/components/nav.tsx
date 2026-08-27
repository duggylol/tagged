'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { getSupabaseClient } from '@/lib/supabase/client';

/**
 * Navigation.
 *
 * Desktop gets a sidebar; mobile gets a bottom bar within thumb reach. This is
 * not just styling — the two form factors are used for genuinely different
 * work. The phone is a camera used standing up in a thrift store; the desktop
 * is where batch editing and analytics happen. Same routes, different weight.
 */

const LINKS = [
  { href: '/dashboard', label: 'Dashboard', icon: SquaresIcon },
  { href: '/inventory', label: 'Inventory', icon: TagIcon },
  { href: '/capture', label: 'Capture', icon: CameraIcon },
  { href: '/connections', label: 'Connections', icon: PlugIcon },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await getSupabaseClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <nav className="hidden w-56 shrink-0 flex-col border-r border-hair px-3 py-5 md:flex">
      <Link href="/dashboard" className="mb-7 px-2">
        <span className="font-display text-2xl font-extrabold tracking-[-0.04em] text-ink">Tagged</span>
      </Link>

      <ul className="flex flex-col gap-0.5">
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active ? 'bg-accent-soft font-medium text-accent' : 'text-mute hover:bg-sunk hover:text-ink'
                }`}
              >
                <Icon />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={signOut}
        className="mt-auto rounded-lg px-3 py-2 text-left text-sm text-mute hover:text-ink"
      >
        Sign out
      </button>
    </nav>
  );
}

export function BottomBar() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-hair bg-card/95 backdrop-blur md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="flex">
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium ${
                  active ? 'text-accent' : 'text-mute'
                }`}
              >
                <Icon />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// --- Icons. Inline so there is no icon-font request and no extra dependency.

function SquaresIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M9.5 2.5H17v7.5l-7.8 7.8a1.4 1.4 0 0 1-2 0l-5.5-5.5a1.4 1.4 0 0 1 0-2z" strokeLinejoin="round" />
      <circle cx="13.5" cy="6.5" r="1.3" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M2.5 6.5h3l1.2-2h6.6l1.2 2h3v10h-15z" strokeLinejoin="round" />
      <circle cx="10" cy="11" r="3.2" />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M7 2.5v5M13 2.5v5" strokeLinecap="round" />
      <path d="M4.5 7.5h11v3a5.5 5.5 0 0 1-11 0z" strokeLinejoin="round" />
      <path d="M10 16v2" strokeLinecap="round" />
    </svg>
  );
}
