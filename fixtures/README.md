# Fixtures

Saved raw payloads, committed on purpose. They are the parser's test inputs
today and the regression suite for the day X reshapes a response — which is
the day you will need them most.

The build spec named five shapes from memory. These are the ones that
actually occur, counted across the real 1,274-item corpus:

| shape | count | why it breaks naive parsers |
|---|---:|---|
| `TweetWithVisibilityResults` | 4 | real tweet nests one level down under `.tweet`; miss it and they vanish |
| deleted / unavailable | 1 | `tweet_results` is `{}` — no `result`, no `__typename` |
| quote | 207 | `quoted_status_result`; quoted text folded into body |
| longform `note_tweet` | 408 | `full_text` is truncated; real text is on `note_tweet` |
| media-only | 5 | entire text is a media t.co; body is legitimately empty after stripping |
| video | 518 | store the poster frame, never the MP4 |
| multi-image | 41 | four entries under `extended_entities.media` |
| non-Latin | 496 | `porter unicode61` stems English only — day 3 will feel this |

**Retweets do not occur.** Zero occurrences of `retweeted_status_result` in
1,374 tweet entries: bookmarking a retweet stores the original post, so the
bookmarks timeline never returns one. The unwrap branch stays as a cheap
guard, but it is not a shape this endpoint produces.

Capture with `anansi ingest`, then lift single entries out of `data/raw/x/`.
Scrub before committing: these come from your own session.
