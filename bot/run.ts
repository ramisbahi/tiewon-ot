import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig } from './config';
import { credentials, XClient } from './x-client';
import { botGames, fetchGames } from './feed';
import { Store } from './store';
import { CONNECTION_TEST, publishGames, publishPost } from './engine';
import { publishWelcome } from './welcome';
import { syncHistory } from './history-sync';

process.umask(0o077);
const shutdown = new AbortController();
process.once('SIGTERM', () => shutdown.abort());
process.once('SIGINT', () => shutdown.abort());

async function main() {
  const config = readConfig();
  const args = process.argv.slice(2);
  const command = args[0];
  const fixtureIndex = args.indexOf('--fixture');
  if (fixtureIndex >= 0 && config.live) throw new Error('Fixture replay is forbidden in live mode');
  if (command === '--check-auth') {
    const username = await new XClient(credentials()).verifyAccount(config.username);
    console.log(`Authenticated as @${username}. No post was sent.`);
    return;
  }
  if (fixtureIndex >= 0) config.database = ':memory:';
  const store = new Store(config.database, config.live ? 'live' : 'dry-run');
  try {
    if (command === '--status') {
      console.log(JSON.stringify({ mode: config.live ? 'live' : 'dry-run', blocked: store.blocked(Date.now()), pauseUntil: store.setting('pause_until'), posts: store.history(), observations: store.observations() }, null, 2));
      return;
    }
    if (command === '--resolve') {
      if (!args[1] || !args[2]) throw new Error('Usage: bot:resolve -- <key> <post-id|not-sent> (stop the worker first)');
      store.resolve(args[1], args[2]);
      console.log('Post resolved.');
      return;
    }
    const client = config.live ? new XClient(credentials()) : undefined;
    if (client) await client.verifyAccount(config.username);
    if (command === '--welcome-post') {
      const result = await publishWelcome(store, config, (text, replyTo) => client!.post(text, replyTo));
      console.log(JSON.stringify({ event: 'welcome-thread', mode: config.live ? 'live' : 'dry-run', ...result, blocked: store.blocked(Date.now()) }));
      return;
    }
    if (command === '--test-post') {
      const published = await publishPost(CONNECTION_TEST, store, config, (text, replyTo) => client!.post(text, replyTo));
      console.log(JSON.stringify({ event: 'connection-test', mode: config.live ? 'live' : 'dry-run', published, blocked: store.blocked(Date.now()) }));
      return;
    }
    console.log(JSON.stringify({ event: 'started', mode: config.live ? 'live' : 'dry-run', account: config.username, pollSeconds: config.pollSeconds }));
    const once = args.includes('--once') || fixtureIndex >= 0;
    let failures = 0;
    do {
      const now = Date.now();
      let games;
      try {
        games = fixtureIndex >= 0
          ? botGames(JSON.parse(readFileSync(args[fixtureIndex + 1], 'utf8')), now)
          : await fetchGames(now);
        failures = 0;
      } catch {
        if (once) throw new Error('Could not load a valid, fresh ESPN scoreboard');
        failures++;
        console.error('ESPN unavailable or invalid; no posts sent. Retrying with backoff.');
      }
      if (games) {
        const published = await publishGames(games, store, config, (text, replyTo) => client!.post(text, replyTo), now);
        console.log(JSON.stringify({ event: 'poll', trackedGames: games.length, published, blocked: store.blocked(now) }));
        if (fixtureIndex < 0) {
          try { await syncHistory(store); }
          catch { console.error('History sync unavailable; snapshots retained locally for retry.'); }
        }
      }
      if (once || shutdown.signal.aborted) break;
      const delay = Math.min(900, config.pollSeconds * 2 ** Math.min(failures, 5));
      await sleep(delay * 1000, undefined, { signal: shutdown.signal }).catch((error: Error) => {
        if (error.name !== 'AbortError') throw error;
      });
    } while (!shutdown.signal.aborted);
  } finally { store.close(); }
}

main().catch((error: Error) => {
  // Only our controlled error messages are emitted, never fetch objects or auth headers.
  console.error(error.message);
  process.exitCode = 1;
});
