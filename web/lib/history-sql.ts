// Shared by the D1 writer and SQLite persistence regression tests.
export const UPSERT_GAME = `INSERT INTO games (id, updated_at, state, overtime, final_tie) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, state=excluded.state, overtime=excluded.overtime, final_tie=excluded.final_tie
        WHERE excluded.updated_at >= games.updated_at
          AND (json_extract(games.state, '$.isLive')=1 OR json_extract(excluded.state, '$.isLive')=0)`;
