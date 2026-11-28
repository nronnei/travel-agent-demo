"""OTLP/JSON trace fixtures for the token rule: one span per source, shaped like the
spans recorded in the plan's step 7 (scopes, span names, attribute names), plus spans
the rule must ignore. Prints the request body to stdout."""

import json
import time

now = time.time_ns()


def attr(k, v):
    return {"key": k, "value": {"intValue": str(v)} if isinstance(v, int) else {"stringValue": v}}


def span(name, attrs, i):
    return {
        "traceId": f"{i:032x}",
        "spanId": f"{i:016x}",
        "name": name,
        "kind": 3,
        "startTimeUnixNano": str(now - 1_000_000_000),
        "endTimeUnixNano": str(now),
        "attributes": [attr(k, v) for k, v in attrs.items()],
    }


def resource(service, scopes):
    return {
        "resource": {"attributes": [attr("service.name", service), attr("service.namespace", "travel-agent-test"), attr("deployment.environment.name", "test")]},
        "scopeSpans": [{"scope": {"name": scope}, "spans": spans} for scope, spans in scopes],
    }


usage = lambda i, o, model: {"gen_ai.usage.input_tokens": i, "gen_ai.usage.output_tokens": o, "gen_ai.response.model": model}
body = {
    "resourceSpans": [
        resource("travel-agent-langgraph", [
            # 11 input + 100 cache read + 7 cache write, already summed by the SDK.
            ("com.anthropic.sdk.typescript", [span("anthropic.messages.create", {**usage(118, 5, "claude-sonnet-5-5"), "gen_ai.provider.name": "anthropic", "gen_ai.usage.cache_read.input_tokens": 100}, 1)]),
            # A platform client (scope suffix) counts too.
            ("com.anthropic.sdk.typescript.bedrock", [span("anthropic.messages.create", {**usage(10, 2, "claude-sonnet-5-5"), "gen_ai.provider.name": "anthropic"}, 2)]),
            # Not LLM usage: ignored.
            ("@opentelemetry/instrumentation-http", [span("POST", {"http.response.status_code": 200}, 3)]),
        ]),
        resource("travel-agent-parlant", [
            ("com.anthropic.sdk.python", [
                span("anthropic.messages.create", {**usage(4013, 88, "claude-haiku-5-5"), "gen_ai.provider.name": "anthropic"}, 4),
                # count_tokens carries its own attribute, not gen_ai.usage.*: ignored.
                span("anthropic.messages.count_tokens", {"anthropic.message.count_tokens.input_tokens": 5000}, 5),
            ]),
        ]),
        resource("travel-agent-inkeep", [
            ("ai", [
                span("ai.streamText.doStream", {**usage(10311, 118, "claude-haiku-5-5"), "gen_ai.system": "anthropic.messages"}, 6),
                # The outer span of the same call: no gen_ai.usage.*, ignored.
                span("ai.streamText", {"ai.usage.inputTokens": 10311}, 7),
            ]),
        ]),
    ]
}
print(json.dumps(body))
