import { Store } from './store';
export async function syncHistory(store: Store, env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
  if (!env.BOT_HISTORY_URL || !env.BOT_HISTORY_TOKEN) return;
  const url = new URL(env.BOT_HISTORY_URL);
  if (url.protocol !== 'https:') throw new Error('BOT_HISTORY_URL must use HTTPS');
  const samples = store.pendingSnapshots();
  if (!samples.length) return;
  const response = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.BOT_HISTORY_TOKEN}` },
    body: JSON.stringify(samples), signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error('History upload failed');
  const result = await response.json();
  if (result.saved !== samples.length) throw new Error('History upload was not acknowledged');
  store.uploaded(samples.map(sample => sample.id));
}
