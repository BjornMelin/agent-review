ALTER TABLE review_runs
  ADD COLUMN IF NOT EXISTS metrics jsonb;
