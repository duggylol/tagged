import { redirect } from 'next/navigation';

import { BottomBar, Sidebar } from '@/components/nav';
import { getCurrentUser } from '@/lib/supabase/server';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      {/* Bottom padding clears the mobile bar; md:pb-8 drops it on desktop. */}
      <main className="min-w-0 flex-1 px-4 pb-24 pt-5 md:px-8 md:pb-10 md:pt-8">{children}</main>
      <BottomBar />
    </div>
  );
}
