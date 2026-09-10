import { gameSnapshots } from '@/lib/history-db';
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('game');
  if (!id || !/^\d{1,20}$/.test(id)) return Response.json({ error: 'Invalid game' }, { status: 400 });
  try { return Response.json({ snapshots: await gameSnapshots(id) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return Response.json({ error: 'History is temporarily unavailable' }, { status: 503 }); }
}
