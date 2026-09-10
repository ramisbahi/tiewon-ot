import { validSnapshot } from '@/lib/history';
import { historyEnvironment, saveSnapshots } from '@/lib/history-db';
export async function POST(request: Request) {
  const secret = historyEnvironment().HISTORY_INGEST_SECRET;
  if (!secret || request.headers.get('Authorization') !== `Bearer ${secret}`) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (Number(request.headers.get('Content-Length')) > 1000000) return Response.json({ error: 'Too large' }, { status: 413 });
  try {
    const text = await request.text();
    if (text.length > 1000000) return Response.json({ error: 'Too large' }, { status: 413 });
    const samples: unknown = JSON.parse(text);
    if (!Array.isArray(samples) || samples.length > 100 || !samples.every(validSnapshot)) return Response.json({ error: 'Invalid snapshots' }, { status: 400 });
    await saveSnapshots(samples);
    return Response.json({ saved: samples.length });
  } catch { return Response.json({ error: 'Could not save history' }, { status: 503 }); }
}
