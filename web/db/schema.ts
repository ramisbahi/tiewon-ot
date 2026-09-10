import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const games = sqliteTable('games', {
  id: text('id').primaryKey(), updatedAt: integer('updated_at').notNull(), state: text('state').notNull(),
  overtime: real('overtime'), finalTie: real('final_tie'),
}, table => [index('idx_games_updated').on(table.updatedAt)]);
export const snapshots = sqliteTable('snapshots', {
  id: text('id').primaryKey(), gameId: text('game_id').notNull(), observedAt: integer('observed_at').notNull(),
  payload: text('payload').notNull(),
}, table => [index('idx_snapshots_game_time').on(table.gameId, table.observedAt)]);
