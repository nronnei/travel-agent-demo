import httpx
import respx

from travel_agent.intake import TripBrief
from travel_agent.intake_client import IntakeClient

CONTEXT = {
    "address": "Dr Ana",
    "givenName": "Ana",
    "surname": "",
    "prefix": "Dr",
    "destination": "",
    "purpose": "",
    "interests": "",
    "briefConfirmed": "no",
}


@respx.mock
async def test_reads_context_and_saves_drafts_with_the_token():
    get = respx.get("http://api/api/intake/c1/context").mock(
        return_value=httpx.Response(200, json=CONTEXT)
    )
    put = respx.put("http://api/api/intake/c1/draft").mock(
        return_value=httpx.Response(200, json={**CONTEXT, "destination": "Lisbon"})
    )
    client = IntakeClient("http://api", "tok")

    assert (await client.context("c1")).address == "Dr Ana"
    brief = TripBrief(destination="Lisbon", purpose="a food tour", interests=[])
    assert (await client.save_draft("c1", brief)).destination == "Lisbon"

    assert get.calls.last.request.headers["x-intake-token"] == "tok"
    assert put.calls.last.request.headers["x-intake-token"] == "tok"
    assert (
        put.calls.last.request.read()
        == b'{"destination":"Lisbon","purpose":"a food tour","interests":[]}'
    )
