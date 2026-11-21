from dataclasses import dataclass
from types import SimpleNamespace

import httpx
import parlant.sdk as p
import pytest

from travel_agent import agent, tools
from travel_agent.intake import IntakeContext, TripBrief
from travel_agent.search_client import (
    SearchClient,
    SearchNotConfiguredError,
    WebSearchResponse,
    WebSearchResult,
)

CONTEXT = IntakeContext(
    address="Dr Ana",
    givenName="Ana",
    surname="",
    prefix="Dr",
    destination="",
    purpose="",
    interests="",
    briefConfirmed="no",
)


class FakeIntake:
    def __init__(self, confirmed: bool = False):
        self.ctx = CONTEXT.model_copy(update={"briefConfirmed": "yes" if confirmed else "no"})
        self.drafts: list[TripBrief] = []

    async def context(self, conversation_id: str) -> IntakeContext:
        return self.ctx

    async def save_draft(self, conversation_id: str, brief: TripBrief) -> IntakeContext:
        self.drafts.append(brief)
        return self.ctx


@pytest.fixture
def intake(monkeypatch):
    fake = FakeIntake()
    monkeypatch.setattr(tools, "intake_client", lambda: fake)
    return fake


@dataclass(frozen=True)
class Var:
    name: str


def rule_ctx(variables=None):
    return SimpleNamespace(variables=variables or {}, customer=SimpleNamespace(id="c1"))


RULE = SimpleNamespace(id="rule-1")


@pytest.mark.parametrize(
    ("confirmed", "intake_active", "planning_active"), [("no", True, False), ("yes", False, True)]
)
async def test_phase_gate_reads_the_guest_brief_variable(confirmed, intake_active, planning_active):
    variables = {Var(agent.GUEST_BRIEF): {"briefConfirmed": confirmed}}
    intake_eval = await agent.in_phase(confirmed=False)(rule_ctx(variables), RULE)
    planning_eval = await agent.in_phase(confirmed=True)(rule_ctx(variables), RULE)
    assert (intake_eval.is_relevant, planning_eval.is_relevant) == (intake_active, planning_active)


async def test_phase_gate_falls_back_to_the_intake_api(intake):
    intake.ctx = intake.ctx.model_copy(update={"briefConfirmed": "yes"})
    assert (await agent.in_phase(confirmed=True)(rule_ctx(), RULE)).is_relevant


def call(tool, **args):
    """Runs a @p.tool function directly with a stand-in ToolContext."""
    context = SimpleNamespace(customer_id="c1")
    fn = getattr(tool, "function", None) or getattr(tool, "__wrapped__", None) or tool
    return fn(context, **args)


async def test_present_brief_saves_the_draft_and_returns_the_widget(intake):
    result = await call(
        tools.present_brief, destination="Lisbon", purpose="a food tour", interests=[]
    )
    assert isinstance(result, p.ToolResult)
    assert result.metadata["widget"]["name"] == "TripBrief"
    assert intake.drafts == [TripBrief(destination="Lisbon", purpose="a food tour", interests=[])]


async def test_present_brief_refuses_placeholders(intake):
    result = await call(tools.present_brief, destination="<UNKNOWN>", purpose="x", interests=[])
    assert not result.metadata
    assert intake.drafts == []


async def test_widgets_stop_once_the_brief_is_confirmed(intake):
    intake.ctx = intake.ctx.model_copy(update={"briefConfirmed": "yes"})
    picker = await call(tools.suggest_interests, destination="Lisbon", extras=[])
    brief = await call(tools.present_brief, destination="Lisbon", purpose="a tour", interests=[])
    assert not picker.metadata and not brief.metadata
    assert intake.drafts == []


# ---- web_search ----


class FakeSearch:
    def __init__(self, error: Exception | None = None):
        self.error = error
        self.calls: list[tuple] = []

    async def search(self, query, max_results=5, recency_days=None):
        self.calls.append((query, max_results, recency_days))
        if self.error:
            raise self.error
        return WebSearchResponse(
            query=query,
            searchedAt="2027-06-01T10:00:00.000Z",
            results=[
                WebSearchResult(title="Festas", url="https://example.com/festas", snippet="June")
            ],
        )


class RecordingContext(SimpleNamespace):
    def __init__(self):
        super().__init__(customer_id="c1", emitted=[])

    async def emit_custom(self, data):
        self.emitted.append(data)


async def run_search(monkeypatch, fake, **args):
    monkeypatch.setattr(tools, "search_client", lambda: fake)
    context = RecordingContext()
    fn = getattr(tools.web_search, "function", None) or tools.web_search
    return context, await fn(context, **args)


async def test_web_search_announces_itself_and_returns_sources(monkeypatch):
    fake = FakeSearch()
    context, result = await run_search(monkeypatch, fake, query="Lisbon events June 2027")

    assert context.emitted == [
        {"type": "web-search", "state": "searching", "query": "Lisbon events June 2027"}
    ]
    assert fake.calls == [("Lisbon events June 2027", 5, None)]
    assert result.data["results"][0]["url"] == "https://example.com/festas"
    assert result.metadata == {
        "search": {
            "query": "Lisbon events June 2027",
            "sources": [{"title": "Festas", "url": "https://example.com/festas"}],
        }
    }


async def test_web_search_clamps_max_results(monkeypatch):
    fake = FakeSearch()
    await run_search(monkeypatch, fake, query="Lisbon", max_results=50, recency_days=7)
    assert fake.calls == [("Lisbon", 8, 7)]


@pytest.mark.parametrize(
    "error",
    [
        httpx.HTTPStatusError(
            "503",
            request=httpx.Request("POST", "http://api/api/search/web"),
            response=httpx.Response(503),
        ),
        httpx.ReadTimeout("timed out"),
        SearchNotConfiguredError("SEARCH_API_TOKEN is not set"),
        ValueError("unexpected"),
    ],
)
async def test_web_search_falls_back_instead_of_raising(monkeypatch, error):
    _, result = await run_search(monkeypatch, FakeSearch(error), query="Lisbon events")
    assert result.data == tools.SEARCH_UNAVAILABLE
    assert result.metadata == {"search": {"query": "Lisbon events", "error": True}}


async def test_web_search_falls_back_with_no_token_configured(monkeypatch):
    monkeypatch.delenv("SEARCH_API_TOKEN", raising=False)
    _, result = await run_search(monkeypatch, SearchClient.from_env(), query="Lisbon events")
    assert result.metadata["search"]["error"] is True


class FakeAgent:
    def __init__(self):
        self.policies: dict[str, dict] = {}
        self.observations: dict[str, dict] = {}

    async def create_variable(self, **kwargs):
        return SimpleNamespace(**kwargs)

    async def create_policy(self, **kwargs):
        self.policies[kwargs["id"]] = kwargs
        return SimpleNamespace(**kwargs)

    async def create_canned_response(self, **kwargs):
        return SimpleNamespace(**kwargs)

    async def create_observation(self, **kwargs):
        self.observations[kwargs["id"]] = kwargs
        return SimpleNamespace(**kwargs)


async def test_only_the_planning_policy_can_search():
    fake = FakeAgent()

    async def create_agent(**kwargs):
        return fake

    await agent.setup(SimpleNamespace(create_agent=create_agent))

    assert fake.policies["trip-planning"]["tools"] == [tools.web_search]
    assert not fake.policies["trip-intake"].get("tools")
    for observation in fake.observations.values():
        assert tools.web_search not in observation.get("tools", [])


def test_effort_from_env(monkeypatch):
    monkeypatch.delenv("PARLANT_INTAKE_EFFORT", raising=False)
    assert agent.effort_from_env("PARLANT_INTAKE_EFFORT", p.Effort.MEDIUM) == p.Effort.MEDIUM
    monkeypatch.setenv("PARLANT_INTAKE_EFFORT", " High ")
    assert agent.effort_from_env("PARLANT_INTAKE_EFFORT", p.Effort.MEDIUM) == p.Effort.HIGH
    monkeypatch.setenv("PARLANT_INTAKE_EFFORT", "turbo")
    with pytest.raises(ValueError):
        agent.effort_from_env("PARLANT_INTAKE_EFFORT", p.Effort.MEDIUM)
