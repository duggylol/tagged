import { notFound } from 'next/navigation';

import { ItemWorkbench } from '@/components/item-workbench';
import { toItem, toListing } from '@/lib/mappers';
import { getServerSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getServerSupabase();

  const [{ data: itemRow }, { data: listingRows }, { data: accountRows }, { data: saleRow }] =
    await Promise.all([
      supabase.from('items').select('*').eq('id', id).maybeSingle(),
      supabase.from('listings').select('*').eq('item_id', id),
      supabase.from('marketplace_accounts').select('platform, connected').eq('connected', true),
      supabase
        .from('sales')
        .select('*')
        .eq('item_id', id)
        .is('confirmed_at', null)
        .order('detected_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  if (!itemRow) notFound();

  const item = toItem(itemRow);
  const listings = (listingRows ?? []).map(toListing);

  // Signed URLs so the browser can show photos from a private bucket.
  const { data: signed } = item.photoPaths.length
    ? await supabase.storage.from('item-photos').createSignedUrls(item.photoPaths, 3600)
    : { data: [] };

  const photoUrls = (signed ?? [])
    .map((entry) => entry.signedUrl)
    .filter((url): url is string => typeof url === 'string' && url.length > 0);

  return (
    <ItemWorkbench
      item={item}
      listings={listings}
      photoUrls={photoUrls}
      connectedPlatforms={(accountRows ?? []).map((row) => row.platform as string)}
      pendingSale={
        saleRow
          ? {
              platform: saleRow.platform as string,
              salePriceCents: saleRow.sale_price_cents as number,
              detectedAt: saleRow.detected_at as string,
            }
          : null
      }
    />
  );
}
