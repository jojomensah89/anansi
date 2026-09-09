# Local AI Batch Throughput Design

**Status:** Approved design; implementation pending

## Goal

Reduce local semantic-indexing and automatic-tagging time without weakening the
durable per-item job guarantees. A queue chunk may contain 50 to 100 jobs, but
provider work must use limits appropriate to each model rather than launching
that many requests simultaneously.

## Current constraint

The local workers now drain available jobs continuously, but the shared runner
still prepares and publishes one item at a time. Increasing its existing
`batchSize` alone does not create provider batching or concurrency, and the
runner currently clamps that value to 20.

The Ollama embedding adapter already accepts multiple texts through
`embedBatch()`, defaulting to provider chunks of 16. The semantic worker calls
only `embed()`, so it converts every item into a separate HTTP request. The tag
adapter exposes only one-bookmark `generateTags()` calls.

## Architecture

Keep the canonical durable job table and its per-item state unchanged. Extend
the runner with an explicit batch execution path that:

1. claims a bounded group of jobs;
2. loads the claimed items together;
3. prepares provider results using a batch-capable executor;
4. maps every result back to its original job in stable input order;
5. revalidates each job's lease, active model, feature toggle, and current
   content hash immediately before publication; and
6. completes, retries, fails, releases, or skips each job independently.

The existing single-item executor remains available for providers and hosted
paths that do not opt into batching.

## Semantic embeddings

Add optional `embedBatch(texts)` capability to the embedding-provider
interface. The local semantic worker opts into the runner's batch path when the
provider supplies it.

- Claim up to 64 embedding jobs per queue round.
- Send texts to Ollama in provider chunks of 16 by default.
- Keep the provider batch size configurable so 32 can be benchmarked locally.
- Require exactly one finite, correctly dimensioned vector for every input.
- Publish vectors in one sidecar write where supported, then acknowledge each
  canonical job only after its mapped vector is safely stored.
- If a batch request fails, mark each affected claim with the existing stable
  failure code. Do not acknowledge partial or ambiguous results.

This changes roughly 1,300 one-text Ollama requests into about 82 requests at a
provider batch size of 16 while retaining item-level durable state.

## Automatic tagging

Do not combine many bookmarks into one prompt. That would couple unrelated
outputs, increase prompt length, make result-to-item mapping fragile, and turn
one malformed response into a whole-batch failure.

Instead, add bounded worker concurrency around the existing one-item structured
chat request:

- Process queue rounds of up to 50 tagging jobs, but claim only enough jobs to
  fill currently available worker slots.
- Run two tagging requests concurrently by default.
- Permit a configurable maximum of four after measurement on the user's GPU.
- Each task preserves the existing structured schema, canonical topic
  allowlist, retry policy, and final per-item validation.
- Stop scheduling new work in the current round after an unavailable-provider
  signal, while already-running requests settle and retain their own outcomes.

No implementation may launch 50 or 100 simultaneous chat requests.

## Queue and lease safety

- Claims remain per item and token-fenced.
- A slow provider must not consume leases for work waiting behind it. The lease
  duration must cover the configured provider batch or concurrency window, and
  jobs are claimed only when a worker slot is ready.
- Model or toggle changes during inference release affected claims without
  consuming an attempt.
- Content changes acknowledge the stale generation and allow reconciliation to
  enqueue the new hash.
- Provider failures remain retryable or terminal according to the existing
  failure classification.
- Overlapping timer or API kicks remain coalesced by each local worker's
  existing running guard.

## Configuration

Use conservative defaults rather than exposing a new product setting:

- embedding queue chunk: 64;
- Ollama embedding request batch: 16;
- tagging queue chunk: 50; and
- tagging concurrency: 2.

Allow environment overrides for developer benchmarking. Reject non-positive,
non-integer, and unsafe values, and cap tagging concurrency at 4.

## Testing and measurement

- Runner tests prove stable result ordering, one load for a claimed batch,
  independent publication, and item-level failure handling.
- Semantic-worker tests prove one multi-text provider call replaces repeated
  single-text calls and that malformed vector counts publish nothing.
- Tagging-worker tests prove the concurrency ceiling, no duplicate claims,
  retry isolation, and no scheduling spin when Ollama is unavailable.
- Existing lease-expiry, settings-fence, content-change, and model-generation
  tests must continue to pass.
- Run focused AI tests, TypeScript checks, the full repository suite, and
  `git diff --check`.
- Benchmark single-item versus 16- and 32-item embeddings, plus tagging
  concurrency 1, 2, and 4, on the current local models. Record elapsed time,
  throughput, failures, and peak GPU memory before changing defaults.

## Acceptance criteria

1. Semantic indexing uses true multi-text Ollama requests when supported.
2. Tagging runs concurrently within a measured ceiling, never as one giant
   multi-bookmark prompt.
3. Queue rounds may cover 50 to 100 jobs without claiming work faster than the
   provider can safely begin it.
4. Every job retains independent validation, publication, retry, and completion
   state.
5. Disabling a feature or changing a model during inference cannot publish a
   stale result or cause a busy loop.
6. Benchmarks demonstrate the selected defaults improve throughput on the
   current machine without new timeouts or out-of-memory failures.
