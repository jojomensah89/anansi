-- TikTok and Reddit derive save_order from the page's import stamp
-- (stamp * 1000 - position). Older imports stamped each later (older) page
-- with a newer time, so save_order itself ran backwards across pages and
-- 0028 could not repair them. Decode stamp and position, order by earliest
-- page first then position, and rewrite both keys newest-first.
UPDATE items SET saved_at = ranked.new_saved_at, save_order = ranked.new_saved_at * 1000
FROM (
  SELECT id,
    MAX(saved_at) OVER (PARTITION BY source)
      - ROW_NUMBER() OVER (
          PARTITION BY source
          ORDER BY (save_order + 999) / 1000 ASC, ((save_order + 999) / 1000) * 1000 - save_order ASC
        ) + 1 AS new_saved_at
  FROM items
  WHERE source IN ('tiktok', 'reddit') AND saved_at_exact = 0 AND save_order IS NOT NULL
) AS ranked
WHERE items.id = ranked.id;
