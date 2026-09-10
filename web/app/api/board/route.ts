import { fetchGames } from '@/lib/live-feed';
import { liveProbabilities } from '@/lib/live-probabilities';
import { snapshot } from '@/lib/history';
import { recentGames, saveSnapshots } from '@/lib/history-db';
export async function GET() {
  let feedAvailable = true;
  let historyAvailable = true;
  let current: Awaited<ReturnType<typeof recentGames>> = [];
  try {
    const games = await fetchGames();
    const observedAt = Date.now();
    current = games.map(game => ({ game, probabilities: liveProbabilities(game), updatedAt: observedAt }));
    try { await saveSnapshots(current.map(s => snapshot(s.game, s.probabilities, observedAt))); }
    catch { historyAvailable = false; console.error('Could not save probability history'); }
  } catch { feedAvailable = false; console.error('ESPN board fetch failed'); }
  let saved: typeof current = [];
  try { saved = await recentGames(); } catch { historyAvailable = false; }
  const ids = new Set(current.map(s => s.game.id));
  return Response.json({ games: [...current, ...saved.filter(s => !ids.has(s.game.id))], feedAvailable, historyAvailable, fetchedAt: Date.now() }, { headers: { 'Cache-Control': 'no-store' } });
}
