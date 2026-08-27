/**
 * Stage timing for the analysis pipeline.
 *
 * `runPipeline` reports one wall-clock number, which is not enough to tell a
 * slow model from a slow image download. This breaks it down so the 60-second
 * function ceiling can be reasoned about rather than guessed at.
 *
 *   npx tsx apps/web/scripts/time-pipeline.ts <itemId>
 */

import { createClient } from '@supabase/supabase-js';
import { GeminiProvider } from '@tagged/ai';
import { selectPhotosForAnalysis } from '@tagged/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const line of readFileSync(resolve(process.cwd(), 'apps/web/.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]!] = m[2]!.trim();
}

const admin = createClient(
  process.env['NEXT_PUBLIC_SUPABASE_URL']!,
  process.env['SUPABASE_SERVICE_ROLE_KEY']!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function mark() {
  const t = Date.now();
  return (label: string) => {
    console.log(`  ${label.padEnd(34)} ${((Date.now() - t) / 1000).toFixed(2)}s`);
    return Date.now();
  };
}

async function main() {
  const itemId = process.argv[2];
  if (!itemId) {
    console.error('Pass an item id.');
    process.exit(1);
  }

  let done = mark();

  const { data: photoRows } = await admin
    .from('capture_photos')
    .select('id, storage_path, role, sequence, item_id, session_id, user_id, phash, width, height, created_at')
    .eq('item_id', itemId)
    .order('sequence');
  done('db: fetch photo rows');

  const chosen = selectPhotosForAnalysis(
    (photoRows ?? []).map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      userId: r.user_id as string,
      itemId: r.item_id as string,
      storagePath: r.storage_path as string,
      phash: (r.phash as string) ?? null,
      width: (r.width as number) ?? null,
      height: (r.height as number) ?? null,
      sequence: (r.sequence as number) ?? 0,
      role: r.role as never,
      createdAt: r.created_at as string,
    })),
  );
  console.log(`  selected ${chosen.length} of ${photoRows?.length ?? 0} photos (${chosen.map((c) => c.role).join(', ')})`);

  done = mark();
  const images = [];
  let bytes = 0;
  for (const photo of chosen) {
    const t0 = Date.now();
    const { data } = await admin.storage.from('item-photos').download(photo.storagePath);
    if (!data) continue;
    const buf = await data.arrayBuffer();
    bytes += buf.byteLength;
    console.log(`    ${photo.role.padEnd(12)} ${(buf.byteLength / 1024).toFixed(0).padStart(5)} KB  ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    images.push({ mimeType: data.type || 'image/webp', data: Buffer.from(buf).toString('base64'), role: photo.role });
  }
  done(`storage: ${images.length} images, ${(bytes / 1024).toFixed(0)} KB total`);

  const provider = new GeminiProvider({
    apiKey: process.env['GEMINI_API_KEY']!,
    visionModel: process.env['AI_VISION_MODEL'],
    copyModel: process.env['AI_COPY_MODEL'],
  });

  done = mark();
  const extraction = await provider.extractAttributes({ images });
  done(`model: extract (${extraction.usage.inputTokens} in / ${extraction.usage.outputTokens} out)`);

  done = mark();
  const written = await provider.writeListing({ attributes: extraction.attributes });
  done(`model: write listing (${written.usage.inputTokens} in / ${written.usage.outputTokens} out)`);

  console.log(`\n  brand: ${extraction.attributes.brand ?? '(none)'} | confidence: ${extraction.attributes.confidence}`);
  console.log(`  title: ${written.core.titleTokens.slice(0, 8).join(' ')}`);
}

void main();
