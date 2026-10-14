CREATE TABLE `item_source_states` (
  `source` text NOT NULL,
  `external_id` text NOT NULL,
  `platform_saved` integer NOT NULL,
  `observed_at` integer NOT NULL,
  PRIMARY KEY (`source`, `external_id`)
);
--> statement-breakpoint
INSERT INTO item_source_states (source, external_id, platform_saved, observed_at)
SELECT source, external_id, platform_saved, last_source_event_at FROM items
WHERE last_source_event_at IS NOT NULL AND source <> 'web';
--> statement-breakpoint
INSERT INTO item_source_states (source, external_id, platform_saved, observed_at)
SELECT source, external_id, CASE WHEN action = 'save' THEN 1 ELSE 0 END, observed_at
FROM (
  SELECT source, external_id, action, observed_at,
    row_number() OVER (PARTITION BY source, external_id ORDER BY observed_at DESC, received_at DESC, rowid DESC) AS rank
  FROM capture_events
  WHERE capture_method = 'platform_event' AND external_id IS NOT NULL
    AND action IN ('save', 'unsave')
) WHERE rank = 1
ON CONFLICT(source, external_id) DO UPDATE SET
  platform_saved = excluded.platform_saved, observed_at = excluded.observed_at
WHERE excluded.observed_at >= item_source_states.observed_at;
