import pytest

from travel_agent import telemetry


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.setattr(telemetry, "_installed", False)
    calls: list[str] = []

    class FakeInstrumentor:
        def instrument(self):
            calls.append("instrument")

    import opentelemetry.instrumentation.anthropic as mod

    monkeypatch.setattr(mod, "AnthropicInstrumentor", FakeInstrumentor)
    return calls


def test_does_nothing_without_the_traces_endpoint(monkeypatch, _reset):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", raising=False)
    monkeypatch.delenv("TRACELOOP_TRACE_CONTENT", raising=False)
    assert telemetry.install_llm_instrumentation() is False
    assert _reset == []
    assert "TRACELOOP_TRACE_CONTENT" not in __import__("os").environ


def test_instruments_with_content_off_by_default(monkeypatch, _reset):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://alloy:4318/v1/traces")
    monkeypatch.delenv("TRACELOOP_TRACE_CONTENT", raising=False)
    assert telemetry.install_llm_instrumentation() is True
    assert _reset == ["instrument"]
    assert __import__("os").environ["TRACELOOP_TRACE_CONTENT"] == "false"


def test_keeps_an_explicit_content_setting(monkeypatch, _reset):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://alloy:4318/v1/traces")
    monkeypatch.setenv("TRACELOOP_TRACE_CONTENT", "true")
    telemetry.install_llm_instrumentation()
    assert __import__("os").environ["TRACELOOP_TRACE_CONTENT"] == "true"


def test_instruments_once(monkeypatch, _reset):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://alloy:4318/v1/traces")
    telemetry.install_llm_instrumentation()
    telemetry.install_llm_instrumentation()
    assert _reset == ["instrument"]
