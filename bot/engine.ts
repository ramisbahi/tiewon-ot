import type { BotGame } from './types';
import { liveProbabilities, type Probabilities } from '../web/lib/live-probabilities';
import type { BotConfig } from './config';
import { nextPost, type Post } from './policy';
import { Store } from './store';
import { XError, validatePostText } from './x-client';

export const WELCOME_POST: Post = {
  key: 'account-welcome:v1', gameId: 'account-welcome', kind: 'welcome', probability: null,
  text: 'Welcome to TieWon! 🏈 We track NFL overtime and final-tie chances, with probability charts and game history. Rooting for the rarest result: nobody wins. 🚨 TieWatch 🇹🇭⌚️\n\nExplore: https://tiewon.sbahirami.chatgpt.site #TieWon',
};

export const CONNECTION_TEST: Post = {
  key: 'account-test:connection', gameId: 'account-test', kind: 'test', probability: 0,
  text: 'TieWon bot connection test. This is a test post, not a live game prediction. #TieWon',
};

export async function publishPost(candidate: Post, store: Store, config: BotConfig, post: (text: string, replyTo?: string) => Promise<string>, now = Date.now(), log: (message: string) => void = console.log) {
  validatePostText(candidate.text);
  if (!store.claim(candidate, config, now)) return false;
  try {
    const id = config.live ? await post(candidate.text, candidate.replyTo) : `dry-run:${candidate.key}`;
    store.sent(candidate.key, id);
    log(JSON.stringify({ event: config.live ? 'published' : 'dry-run', key: candidate.key, id, text: candidate.text }));
    return true;
  } catch (error) {
    if (error instanceof XError && error.status >= 400 && error.status < 500 && error.status !== 408) {
      store.failed(candidate.key, 'rejected', error.message);
      store.pauseUntil(Math.max(error.retryAt, now + (error.status === 429 ? 15 * 60_000 : 3600_000)));
      if (error.status !== 429) throw new Error(`${error.message}; check app permissions, credentials, and credits. Posting paused for at least one hour.`);
      log('X rate limit reached; posting paused until the retry window.');
    } else {
      // POST has no reliable idempotency key. A timeout/5xx may have published it.
      store.failed(candidate.key, 'uncertain', 'Delivery uncertain; inspect the account and resolve this post before resuming');
      throw new Error(`Delivery uncertain for ${candidate.key}; posting paused. Use bot:status and bot:resolve.`);
    }
    return false;
  }
}

export async function publishGames(games: BotGame[], store: Store, config: BotConfig, post: (text: string, replyTo?: string) => Promise<string>, now = Date.now(), log: (message: string) => void = console.log, predict: (game: BotGame) => Probabilities = game => liveProbabilities(game, config.overtimeRuns)) {
  let published = 0;
  let attempts = 0;
  const candidates = games.flatMap(game => {
    const probabilities = predict(game);
    store.observe(game, probabilities, now);
    const candidate = nextPost(game, store.gameHistory(game.id), game.quarter > 4 ? probabilities.finalTie : probabilities.overtime, probabilities);
    return candidate ? [candidate] : [];
  });
  const priority = (p: Post) => p.kind === 'overtime' ? 0 : p.kind === 'final' ? 1 : (p.kind === 'halftime' || p.kind === 'quarter') ? 2 : p.kind === 'ot_threshold' ? 3 : 4;
  // Resolve actual outcomes before spending the daily budget on forecasts.
  for (const candidate of candidates.sort((a, b) => priority(a) - priority(b))) {
    // At most three 15-second requests per snapshot; remaining games get a fresh poll.
    if (store.blocked(now) || attempts >= 3) break;
    if (await publishPost(candidate, store, config, post, now, log)) {
      attempts++;
      published++;
    }
  }
  return published;
}
