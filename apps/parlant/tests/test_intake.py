import pytest
from pydantic import ValidationError

from travel_agent.intake import TripBrief, kebab, widget
from travel_agent.tools import interest_picker_props


def test_brief_rejects_placeholders_like_the_shared_schema():
    for bad in ["<UNKNOWN>", "unknown", "N/A", "tbd", "none", "  ", "x" * 201]:
        with pytest.raises(ValidationError):
            TripBrief(destination=bad, purpose="a food tour", interests=[])
    brief = TripBrief(destination="  Lisbon ", purpose="a food tour", interests=["Food & drink"])
    assert brief.destination == "Lisbon"


def test_widget_matches_the_web_apps_component_shape():
    brief = TripBrief(destination="Lisbon", purpose="a food tour", interests=[])
    assert widget("TripBrief", brief) == {
        "name": "TripBrief",
        "props": {"destination": "Lisbon", "purpose": "a food tour", "interests": []},
    }


def test_interest_picker_keeps_up_to_three_new_extras():
    props = interest_picker_props(
        "Lisbon", ["Fado music", "Beaches", "", "Azulejo tiles", "Pastel de nata", "Trams"]
    )
    assert props.prompt == "What should your time in Lisbon focus on?"
    assert [o.model_dump() for o in props.extras] == [
        {"id": "fado-music", "label": "Fado music"},
        {"id": "azulejo-tiles", "label": "Azulejo tiles"},
        {"id": "pastel-de-nata", "label": "Pastel de nata"},
    ]


def test_kebab():
    assert kebab("Onsen & hot springs") == "onsen-hot-springs"
