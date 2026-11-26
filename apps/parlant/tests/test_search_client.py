import json

import httpx
import pytest
import respx

from travel_agent.search_client import SearchClient, SearchNotConfiguredError

RESPONSE = {
    "query": "Lisbon events June 2027",
    "searchedAt": "2027-06-01T10:00:00.000Z",
    "results": [
        {
            "title": "Festas de Lisboa",
            "url": "https://example.com/festas",
            "snippet": "June",
            "publishedAt": "2027-05-01T00:00:00.000Z",
        },
        {"title": "B", "url": "https://example.com/b", "snippet": "b"},
    ],
}


@respx.mock
async def test_posts_the_query_with_the_bearer_token():
    route = respx.post("http://api/api/search/web").mock(
        return_value=httpx.Response(200, json=RESPONSE)
    )
    client = SearchClient("http://api", "tok")

    res = await client.search("Lisbon events June 2027", 3, 14)

    assert res.results[0].title == "Festas de Lisboa"
    assert res.results[1].publishedAt is None
    request = route.calls.last.request
    assert request.headers["authorization"] == "Bearer tok"
    assert request.headers["x-search-client"] == "parlant"
    assert json.loads(request.read()) == {
        "query": "Lisbon events June 2027",
        "maxResults": 3,
        "recencyDays": 14,
    }


@respx.mock
async def test_omits_recency_when_unset():
    route = respx.post("http://api/api/search/web").mock(
        return_value=httpx.Response(200, json=RESPONSE)
    )
    await SearchClient("http://api", "tok").search("Lisbon events")
    assert json.loads(route.calls.last.request.read()) == {
        "query": "Lisbon events",
        "maxResults": 5,
    }


@respx.mock
async def test_raises_on_http_errors():
    respx.post("http://api/api/search/web").mock(return_value=httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        await SearchClient("http://api", "tok").search("Lisbon events")


async def test_a_missing_token_does_not_raise_until_searching(monkeypatch):
    monkeypatch.delenv("SEARCH_API_TOKEN", raising=False)
    client = SearchClient.from_env()
    with pytest.raises(SearchNotConfiguredError):
        await client.search("Lisbon events")


def test_sets_the_client_header_with_and_without_a_token():
    with_token = SearchClient("http://api", "tok")._http.headers
    without = SearchClient("http://api", None)._http.headers
    assert with_token["x-search-client"] == "parlant"
    assert without["x-search-client"] == "parlant"
    assert "authorization" not in without
