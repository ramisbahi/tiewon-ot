export interface BotConfig {
  live: boolean;
  username: string;
  database: string;
  pollSeconds: number;
  minProbability: number;
  minChange: number;
  cooldownSeconds: number;
  maxPostsPerGame: number;
  maxPostsPerDay: number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  function number(name: string, fallback: number, min: number, max: number) {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  }
  if (env.BOT_LIVE && !['true', 'false'].includes(env.BOT_LIVE)) throw new Error('BOT_LIVE must be true or false');
  const live = env.BOT_LIVE === 'true';
  return {
    live,
    username: (env.X_EXPECTED_USERNAME || 'NFL_TieWon').replace(/^@/, ''),
    database: env.BOT_DATABASE || `../.bot-state/${live ? 'live' : 'dry-run'}.sqlite`,
    pollSeconds: number('BOT_POLL_SECONDS', 30, 15, 3600),
    minProbability: number('BOT_MIN_PROBABILITY', 0.15, 0, 1),
    minChange: number('BOT_MIN_CHANGE', 0.1, 0.01, 1),
    cooldownSeconds: number('BOT_COOLDOWN_SECONDS', 180, 30, 3600),
    maxPostsPerGame: Math.floor(number('BOT_MAX_POSTS_PER_GAME', 6, 2, 20)),
    maxPostsPerDay: Math.floor(number('BOT_MAX_POSTS_PER_DAY', 50, 1, 200)),
  };
}
