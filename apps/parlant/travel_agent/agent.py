"""The travel agent on Parlant: one agent, gated into intake and planning.

Inkeep runs this as two sub-agents with a model-decided transfer. Here it is
one agent whose rules are switched by the guest's confirmed brief, read in code
on every turn, so the hand-off to planning is deterministic. Within the
intake, observations attach the widget tools when the conversation calls for
them, and canned responses give the fixed lines their wording.
"""

import os

import parlant.sdk as p

from . import prompts, tools

AGENT_ID = "travel-agent"
GUEST_BRIEF = "guest_brief"

# On Anthropic, Parlant writes replies with Haiku 5.5 up to MEDIUM effort,
# Sonnet 5.5 at HIGH and Opus 5.5 at MAX. Measured on the dev cluster
# (2026-11-14), MEDIUM intake (Haiku) was no faster than HIGH: a turn's time
# goes to Parlant's work before the reply, not to writing it. So intake stays
# on HIGH, the setting the comparison was validated on; both are settable for
# experiments (PARLANT_INTAKE_EFFORT, PARLANT_PLANNING_EFFORT). Below MEDIUM,
# rules that carry tools (the widget observations) are matched by embedding
# recall alone, not ranked.
DEFAULT_INTAKE_EFFORT = p.Effort.HIGH
DEFAULT_PLANNING_EFFORT = p.Effort.HIGH


def effort_from_env(name: str, default: p.Effort) -> p.Effort:
    """An effort level (min, low, medium, high, max) from the environment."""
    value = os.environ.get(name, "").strip().lower()
    return p.Effort(value) if value else default


async def _brief_confirmed(ctx: p.RuleEvaluationContext) -> bool:
    """From this turn's guest_brief variable, or the intake API if it isn't loaded."""
    for variable, value in ctx.variables.items():
        if variable.name == GUEST_BRIEF and isinstance(value, dict):
            return value.get("briefConfirmed") == "yes"
    intake = await tools.intake_client().context(ctx.customer.id)
    return intake.briefConfirmed == "yes"


def in_phase(*, confirmed: bool):
    """An evaluation_func active only before (or after) the guest confirms their brief."""

    async def evaluate(ctx: p.RuleEvaluationContext, rule: p.Policy) -> p.RuleEvaluation:
        is_confirmed = await _brief_confirmed(ctx)
        return p.RuleEvaluation(
            id=rule.id,
            is_relevant=is_confirmed == confirmed,
            reasoning=f"brief {'confirmed' if is_confirmed else 'not confirmed'}",
        )

    return evaluate


async def setup(
    server: p.Server,
    *,
    intake_effort: p.Effort = DEFAULT_INTAKE_EFFORT,
    planning_effort: p.Effort = DEFAULT_PLANNING_EFFORT,
) -> p.Agent:
    # The agent's own effort is the intake's; the planning policy raises it.
    agent = await server.create_agent(
        id=AGENT_ID,
        name="Concierge",
        instructions=prompts.AGENT_DESCRIPTION,
        effort=intake_effort,
    )

    await agent.create_variable(
        name=GUEST_BRIEF,
        description="The guest's own entries: address, destination, purpose, interests, "
        "and whether they have confirmed the brief",
        tool=tools.get_guest_brief,
    )

    intake = await agent.create_policy(
        id="trip-intake",
        title=prompts.INTAKE_TITLE,
        content=prompts.INTAKE_PROCEDURE,
        evaluation_func=in_phase(confirmed=False),
    )

    interests_line = await agent.create_canned_response(
        # The picker asks its own question, so this line must not repeat it.
        template="Splendid. Choose as many as you like.",
        note="Said with the interest picker, which shows the question and the options.",
    )
    await agent.create_observation(
        id="offer-interest-picker",
        condition="The guest has given their destination and a general trip purpose (one "
        "that only describes the mood, occasion or company, not what they will actually "
        "do), and has not chosen interests yet",
        tools=[tools.suggest_interests],
        canned_responses=[interests_line],
        dependencies=[intake],
    )

    brief_line = await agent.create_canned_response(
        # The brief's recap ends with "Have I got that right?" itself.
        template="Here is your trip brief.",
        note="Said with the trip brief, which shows the details and asks for confirmation.",
    )
    updated_line = await agent.create_canned_response(
        template="Of course. Here is the updated brief:",
        note="Said with a trip brief changed at the guest's request.",
    )
    await agent.create_observation(
        id="present-trip-brief",
        condition="The guest has given their destination and purpose, and has either "
        "picked interests or given a purpose specific enough to plan around; or the guest "
        "asked to change something in a trip brief they were shown",
        tools=[tools.present_brief],
        canned_responses=[brief_line, updated_line],
        dependencies=[intake],
    )

    handoff_line = await agent.create_canned_response(
        template="Wonderful. Let's start planning your trip.",
        note="The first planning reply, right after the guest confirms their brief.",
    )
    await agent.create_policy(
        id="trip-planning",
        title=prompts.PLANNING_TITLE,
        content=prompts.PLANNING_POLICY,
        evaluation_func=in_phase(confirmed=True),
        canned_responses=[handoff_line],
        # A rule can only raise a turn's effort, so this is a no-op if it isn't higher.
        trigger_effort=planning_effort,
        # Planning only: intake never searches.
        tools=[tools.web_search],
    )

    return agent
