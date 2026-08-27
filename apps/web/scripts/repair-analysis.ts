/**
 * Re-run analysis on items that are stuck.
 *
 * An item can end up parked on `pending` or `failed` — a deploy that went out
 * mid-run, a provider outage, a function that hit its ceiling. Nothing
 * re-queues those automatically, so this is the operator's tool for clearing
 * them without asking the seller to tap Retry on each one.
 *
 * It calls the exact same `runPipeline` the API route does, so a green run
 * here means the production path works, not merely that a copy of it does.
 *
 * Usage, from the repo root:
 *   npx tsx apps/web/scripts/repair-analysis.ts            # every stuck item
 *   npx tsx apps/web/scripts/repair-analysis.ts <itemId>   # just one
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runPipeline } from '../src/lib/pipeline';

// Load apps/web/.env.local without pulling in a dotenv dependency. Run from
// the repo root.
//
// Split on \r?\n rather than \n: on a CRLF file the trailing \r survives, and
// JavaScript's `.` does not match \r, so `(.*)$` fails on every line and the
// loop silently parses nothing.
const envPath = resolve(process.cwd(), 'apps/web/.env.local');
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) process.env[match[1]!] = match[2]!.trim();
}

const url = process.env['NEXT_PUBLIC_SUPABASE_URL']!;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']!;

// Service role for both handles: RLS is bypassed, so every query must be
// scoped by the ids we already resolved. Fine here — we look items up first
// and only ever touch those.
const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const only = process.argv[2];

  const query = admin
    .from('items')
    .select('id, user_id, analysis_status, photo_paths')
    .in('analysis_status', only ? ['pending', 'failed', 'complete'] : ['pending', 'failed']);

  const { data: items, error } = only ? await query.eq('id', only) : await query;

  if (error) {
    console.error('Could not list items:', error.message);
    process.exit(1);
  }
  if (!items?.length) {
    console.log('Nothing to repair.');
    process.exit(0);
  }

  console.log(`Repairing ${items.length} item(s)\n`);

  let ok = 0;
  let failed = 0;

  for (const item of items) {
    const photos = item.photo_paths?.length ?? 0;
    process.stdout.write(`${item.id}  (${photos} photo${photos === 1 ? '' : 's'})  … `);

    if (photos === 0) {
      console.log('skipped — no photos');
      continue;
    }

    const started = Date.now();
    try {
      const result = await runPipeline(admin, admin, item.user_id, item.id);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);

      console.log(`done in ${seconds}s`);
      console.log(`    brand:      ${result.attributes.brand ?? '(not read)'}`);
      console.log(`    item:       ${result.attributes.subcategory ?? result.attributes.category ?? '(unknown)'}`);
      console.log(`    size:       ${result.attributes.size ?? '(not read)'}`);
      console.log(`    confidence: ${(result.attributes.confidence * 100).toFixed(0)}%`);
      console.log(`    price:      $${(result.priceSuggestion.listPriceCents / 100).toFixed(2)} from ${result.compsFound} comps`);
      console.log(`    title:      ${result.listingCore.titleTokens.slice(0, 8).join(' ')}`);
      console.log(`    cost:       $${result.totalCostUsd.toFixed(5)}`);
      if (result.attributes.uncertainNotes.length) {
        console.log(`    unsure:     ${result.attributes.uncertainNotes.join('; ')}`);
      }
      console.log();
      ok += 1;
    } catch (cause) {
      console.log(`FAILED — ${cause instanceof Error ? cause.message : String(cause)}\n`);
      failed += 1;
    }
  }

  console.log(`${ok} repaired, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);

}

void main();
