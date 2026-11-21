# tests/chaos

`failure_injection.test.mjs` — concurrency and fault injection against the real
SQLite D1 shim and the real worker/handlers:

| scenario | what is asserted |
|---|---|
| 60 concurrent sends | `room_seq` is contiguous 1..60, no duplicate ids, no 500 |
| same idempotency key ×5 in parallel | exactly one message exists |
| one injected D1 write failure | 500 with no internal detail, no partial row, retry with the same key succeeds |
| reconnect without a known socket | the DO answers `CLOSE`/snapshot, never a guessed replay |
| expired WS ticket / heartbeat sweep | socket closed with `expired` / `heartbeat_timeout` |
| duplicate webhook delivery | one `ci_runs` row, one state transition, delivery deduped |
| backup then change | restore planning reports per-table drift and changed signatures |
| timeout / 401 / 429 | continuity plan reconciles, re-auths or honours Retry-After; never blind re-run |
| handoff / dispatch guards | refusal when the checkpoint, successor capability or usage figure is not proven |

Run:

```
node --test tests/chaos/*.test.mjs
```

Not covered here (needs infrastructure this track does not deploy): real DO
restart, real D1 latency/replica lag, real GitHub rate limiting. Those remain
`BLOCKED_EXTERNAL_DEPENDENCY` for the release gate and are not reported as PASS.
