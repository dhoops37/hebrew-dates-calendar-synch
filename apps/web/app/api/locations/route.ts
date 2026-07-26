import { NextResponse } from 'next/server';
import { listLocations } from '@/lib/preview';

/**
 * Phase 1 serves the built-in seed catalogue. In Phase 2 this route is where a
 * geocoding provider is called instead, behind the same response shape - the
 * client never learns which provider answered.
 */
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q') ?? '';
  return NextResponse.json({ locations: listLocations(query) });
}
