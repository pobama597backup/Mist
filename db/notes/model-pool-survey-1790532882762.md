# model-pool-survey

- created: 2026-09-27T18:14:42.763Z

# Model Pool Survey Results

## Probe Results (Live)

| Lane | Status | Latency | Model Returned | Limits | Notes |
|------|--------|---------|----------------|--------|-------|
| **kilo** | ✅ active | **1029 ms** | nvidia/nemotron-3-ultra-550b-a55b:free (550B reasoning, 1M ctx) | 200 req/hr/IP · 18-model pool | Keyless, out-of-box, auto-rotates on rate-limit |
| **pollinations** | ✅ active | **503 ms** | gpt-oss-20b (reasoning, tools) | Anonymous tier · seconds between reqs | OpenAI-compatible, fast but smaller model |
| **llm7** | ✅ active | **1451 ms** | minimax-m2.7 | 1 req/sec · 10 RPM · 60/hr · 500K tokens/24h | 64 models incl. DeepSeek-V4, GLM, Claude, but stricter limits |
| **ovh** | ❌ failed | N/A | Qwen3.5-397B, gpt-oss-120b, Qwen3.6-27B all HTTP 429 | Exhausted/rate-limited | All keyless models returned 429 |

## Model Catalogs (Discover)

- **kilo**: 18 models — highlights: nemotron-3-ultra-550b (1M ctx), nemotron-3.5-lightning (1M ctx), inkling-small (1M ctx), laguna-s-2.1 (262K ctx)
- **llm7**: 64 models — highlights: DeepSeek-V4.1-Flash (1M ctx), GLM-5.3-Flash (400K ctx), Inkling (512K ctx), multiple Claude variants

## Reasoning for Pick

**Winner: kilo + nvidia/nemotron-3-ultra-550b-a55b:free**

1. **Model class**: 550B parameter Nemotron-3-Ultra — a top-tier reasoning model, not a distilled small model
2. **Context**: 1,000,000 tokens — matches or exceeds all alternatives
3. **Latency**: 1029 ms — acceptable, only ~2x pollinations (which serves a 20B model)
4. **Reliability**: Active, 200 req/hr limit is generous for autonomous use; pool auto-rotates on upstream rate-limit
5. **Zero auth**: Truly keyless, out-of-box, no signup
6. **Fallback**: kilo-auto/free rotates the whole 18-model pool if the pinned model hits limits

Pollinations is faster but serves gpt-oss-20b (much smaller). llm7 has more model variety but stricter rate limits (60/hr) and higher latency. OVH is currently exhausted.

**Decision**: Pin kilo to nvidia/nemotron-3-ultra-550b-a55b:free for maximum reasoning capability with generous limits and proven reliability.
