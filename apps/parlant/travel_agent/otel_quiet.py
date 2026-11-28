"""Silences the console copy of Parlant's OpenTelemetry spans.

Parlant 4.x's tracer always adds a `ConsoleSpanExporter`
(`parlant/adapters/tracing/opentelemetry.py`), so with OTEL on every span is
also printed as JSON to stdout and shipped to Loki: a second copy of the trace
data, with its own retention. This patch turns that exporter into a no-op. The
OTLP exporter and Parlant's own logging are untouched.

Set PARLANT_CONSOLE_SPANS=1 to get the console spans back (local debugging).
Re-check on Parlant upgrades, like `anthropic_thinking`.
"""

import os
from collections.abc import Sequence

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SpanExportResult

_original_export = ConsoleSpanExporter.export


def _quiet_export(self: ConsoleSpanExporter, spans: Sequence[ReadableSpan]) -> SpanExportResult:
    return SpanExportResult.SUCCESS


def install() -> None:
    """Patch `ConsoleSpanExporter.export` unless PARLANT_CONSOLE_SPANS=1. Idempotent."""
    if os.environ.get("PARLANT_CONSOLE_SPANS") == "1":
        ConsoleSpanExporter.export = _original_export  # type: ignore[method-assign]
    else:
        ConsoleSpanExporter.export = _quiet_export  # type: ignore[method-assign]
