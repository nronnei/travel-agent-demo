"""LLM token usage for Parlant, via OpenLLMetry's Anthropic instrumentation.

With OTEL on (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT set), every Anthropic call
gets a `gen_ai` span with token counts and records the semconv histogram
`gen_ai.client.token.usage` (`gen_ai.token.type` input/output, where input
includes cache reads and writes). Both go through Parlant's own global tracer
and meter providers. The Node backends record the same metric, so the
dashboard compares tokens across backends and survives a move to Bedrock
(swap in the Bedrock instrumentation).

Prompt and completion text stays off unless TRACELOOP_TRACE_CONTENT is
explicitly "true": the instrumentor's own default is on.
"""

import os

_installed = False


def install_llm_instrumentation() -> bool:
    """Instrument the Anthropic SDK when OTEL tracing is on. Returns whether it did."""
    global _installed
    if _installed:
        return True
    if not os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"):
        return False
    os.environ.setdefault("TRACELOOP_TRACE_CONTENT", "false")
    from opentelemetry.instrumentation.anthropic import AnthropicInstrumentor

    AnthropicInstrumentor().instrument()
    _installed = True
    return True
