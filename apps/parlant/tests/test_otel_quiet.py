import io

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    ConsoleSpanExporter,
    SimpleSpanProcessor,
    SpanExportResult,
)

from travel_agent import otel_quiet


def _export_one(out: io.StringIO) -> SpanExportResult:
    provider = TracerProvider()
    exporter = ConsoleSpanExporter(out=out)
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    with provider.get_tracer("t").start_as_current_span("s"):
        pass
    return exporter.export([])


def test_console_spans_are_silenced_by_default(monkeypatch):
    monkeypatch.delenv("PARLANT_CONSOLE_SPANS", raising=False)
    otel_quiet.install()
    out = io.StringIO()
    assert _export_one(out) == SpanExportResult.SUCCESS
    assert out.getvalue() == ""


def test_console_spans_come_back_with_the_env_switch(monkeypatch):
    monkeypatch.setenv("PARLANT_CONSOLE_SPANS", "1")
    otel_quiet.install()
    out = io.StringIO()
    _export_one(out)
    assert '"name": "s"' in out.getvalue()
    monkeypatch.delenv("PARLANT_CONSOLE_SPANS")
    otel_quiet.install()
