-- Drizzle rebuilds acc_journal_lines in the next migration. SQLite validates
-- surviving trigger bodies during RENAME, so temporarily detach its normalizer.
-- The migrator executes the preparation, rebuild and guard restoration together.
DROP TRIGGER IF EXISTS acc_normalize_journal;
