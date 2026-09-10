export interface BotConfig {
  live: boolean;
  username: string;
  database: string;
  pollSeconds: number;
  maxForecastsPerDay: number;
  overtimeRuns: number;
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
    pollSeconds: number('BOT_POLL_SECONDS', 15, 15, 3600),
    maxForecastsPerDay: Math.floor(number('BOT_MAX_FORECASTS_PER_DAY', 128, 1, 500)),
    overtimeRuns: Math.floor(number('BOT_OVERTIME_RUNS', 10000, 1000, 100000)),
  };
}
