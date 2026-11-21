"""Reads and writes the guest's intake record in the Nest API."""

import os

import httpx

from .intake import IntakeContext, TripBrief

INTAKE_TOKEN_HEADER = "x-intake-token"


class IntakeClient:
    def __init__(self, base_url: str, token: str, *, timeout: float = 5.0) -> None:
        self._http = httpx.AsyncClient(
            base_url=base_url,
            headers={INTAKE_TOKEN_HEADER: token},
            timeout=timeout,
        )

    @classmethod
    def from_env(cls) -> "IntakeClient":
        return cls(
            os.environ.get("INTAKE_API_URL", "http://localhost:3000"),
            os.environ["INTAKE_API_TOKEN"],
        )

    async def context(self, conversation_id: str) -> IntakeContext:
        res = await self._http.get(f"/api/intake/{conversation_id}/context")
        res.raise_for_status()
        return IntakeContext.model_validate(res.json())

    async def save_draft(self, conversation_id: str, brief: TripBrief) -> IntakeContext:
        res = await self._http.put(
            f"/api/intake/{conversation_id}/draft", json=brief.model_dump(mode="json")
        )
        res.raise_for_status()
        return IntakeContext.model_validate(res.json())

    async def aclose(self) -> None:
        await self._http.aclose()
