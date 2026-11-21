"""Web search through the Nest API (`POST /api/search/web`).

Mirrors `WebSearchResponseSchema` in packages/shared/src/search.ts. The API
holds the provider key, applies the cache and limits, and expects
`Authorization: Bearer <SEARCH_API_TOKEN>`.
"""

import os

import httpx
from pydantic import BaseModel


class WebSearchResult(BaseModel):
    title: str
    url: str
    snippet: str
    publishedAt: str | None = None


class WebSearchResponse(BaseModel):
    query: str
    searchedAt: str
    results: list[WebSearchResult]


class SearchNotConfiguredError(RuntimeError):
    """SEARCH_API_TOKEN isn't set; the tool falls back instead of searching."""


class SearchClient:
    def __init__(self, base_url: str, token: str | None, *, timeout: float = 10.0) -> None:
        self._token = token
        self._http = httpx.AsyncClient(
            base_url=base_url,
            headers={"authorization": f"Bearer {token}"} if token else {},
            timeout=timeout,
        )

    @classmethod
    def from_env(cls) -> "SearchClient":
        # Unlike IntakeClient, a missing token doesn't raise here: search() fails
        # instead, and the tool answers with its fallback.
        return cls(
            os.environ.get("INTAKE_API_URL", "http://localhost:3000"),
            os.environ.get("SEARCH_API_TOKEN") or None,
        )

    async def search(
        self, query: str, max_results: int = 5, recency_days: int | None = None
    ) -> WebSearchResponse:
        if not self._token:
            raise SearchNotConfiguredError("SEARCH_API_TOKEN is not set")
        body: dict[str, object] = {"query": query, "maxResults": max_results}
        if recency_days is not None:
            body["recencyDays"] = recency_days
        res = await self._http.post("/api/search/web", json=body)
        res.raise_for_status()
        return WebSearchResponse.model_validate(res.json())

    async def aclose(self) -> None:
        await self._http.aclose()
