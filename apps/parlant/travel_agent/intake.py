"""Intake data, mirrored from packages/shared/src/intake.ts.

Keep these in step with the zod schemas there: the web app validates every
widget against them, so a prop that passes here but fails there is dropped.
"""

import re
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field, StringConstraints

MAX_EXTRA_INTERESTS = 3

# The curated list every picker offers (BASE_INTERESTS). Extras must add to it.
BASE_INTEREST_LABELS = (
    "Food & drink",
    "Culture & history",
    "Art & museums",
    "Outdoors & nature",
    "Adventure & sport",
    "Relaxation & wellness",
    "Beaches",
    "Nightlife",
    "Shopping",
    "Family activities",
)

_PLACEHOLDER = re.compile(r"^(<.*>|unknown|n/a|tbd|none)$", re.IGNORECASE)


def _answered(value: str) -> str:
    """Rejects model placeholders like "<UNKNOWN>" or "tbd" in place of a real answer."""
    if _PLACEHOLDER.match(value):
        raise ValueError("placeholder value")
    return value


Answered = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
    AfterValidator(_answered),
]
InterestLabel = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)
]


class InterestOption(BaseModel):
    id: Annotated[str, StringConstraints(min_length=1)]
    label: Annotated[str, StringConstraints(min_length=1)]


class InterestPickerProps(BaseModel):
    prompt: Annotated[str, StringConstraints(min_length=1)]
    extras: list[InterestOption] = Field(default_factory=list, max_length=MAX_EXTRA_INTERESTS)


class TripBrief(BaseModel):
    destination: Answered
    purpose: Answered
    interests: list[InterestLabel] = Field(default_factory=list, max_length=20)


class IntakeContext(BaseModel):
    """GET /api/intake/:id/context: flat strings, empty until known."""

    address: str
    givenName: str
    surname: str
    prefix: str
    destination: str
    purpose: str
    interests: str
    briefConfirmed: Literal["yes", "no"]


def widget(name: Literal["InterestPicker", "TripBrief"], props: BaseModel) -> dict:
    """A widget for the web app, in the `{name, props}` shape of IntakeComponentDataSchema."""
    return {"name": name, "props": props.model_dump(mode="json")}


def kebab(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
