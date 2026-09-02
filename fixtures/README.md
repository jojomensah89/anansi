# Fixtures

Saved raw payloads, committed on purpose. They are the parser's test inputs
today and the regression suite for the day X reshapes a response — which is
the day you will need them most.

The five shapes that break naive normalizers, per the build spec:

| file | shape |
|---|---|
| `retweet.json` | `retweeted_status_result`, author must resolve to the original |
| `quote.json` | `quoted_status_result`, quoted text folded into body |
| `thread-reply.json` | `in_reply_to_status_id_str` set, conversation id present |
| `four-images.json` | four entries under `extended_entities.media` |
| `video.json` | `type: "video"`, stored as a poster frame, never the MP4 |

Capture them with `anansi import x --pages 1`, then lift single entries out of
`data/raw/x/`. Scrub before committing: these come from your own session.
