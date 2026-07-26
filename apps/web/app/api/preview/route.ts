import { NextResponse } from 'next/server';
import { buildPreview, type PreviewRequest } from '@/lib/preview';

/**
 * Sunset and Hebrew-date calculation runs server-side (PRD 13.4), so the client
 * posts what the user typed and receives a finished preview.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: PreviewRequest;
  try {
    body = (await request.json()) as PreviewRequest;
  } catch {
    return NextResponse.json({ status: 'error', message: 'Invalid JSON body' }, { status: 400 });
  }

  const preview = buildPreview(body);
  return NextResponse.json(preview, { status: preview.status === 'error' ? 400 : 200 });
}
