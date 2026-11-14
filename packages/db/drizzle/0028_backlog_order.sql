-- Imports before this fix gave each older page of history a newer saved_at
-- than the page before it, so the oldest saves sat at the top of the library.
-- Re-stamp inexact backfill rows so saved_at follows the platform's own
-- save order (newest first), keeping each source's newest stamp.
UPDATE items SET saved_at = ranked.new_saved_at
FROM (
  SELECT id,
    MAX(saved_at) OVER (PARTITION BY source)
      - ROW_NUMBER() OVER (PARTITION BY source ORDER BY save_order DESC, saved_at DESC) + 1 AS new_saved_at
  FROM items
  WHERE saved_at_exact = 0 AND save_order IS NOT NULL
) AS ranked
WHERE items.id = ranked.id;
