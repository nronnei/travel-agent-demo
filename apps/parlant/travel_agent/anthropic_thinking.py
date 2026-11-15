"""Works around Parlant 4.0.5 replaying stale thinking blocks to Anthropic.

Within one turn, Parlant's reply loop runs several steps (e.g. tool calls, then
the reply) and rebuilds earlier messages between them, while replaying the
signed thinking blocks from the earlier steps. Claude binds each thinking block
to the conversation prefix it was created in, so the replay fails with a 400:
"Invalid `signature` in `thinking` block. The block is bound to a different
conversation." In this agent it broke every turn that showed a widget.

The API's own remedy is to let it drop mismatched blocks
(`thinking.block_binding.prefix_mismatch_behavior: "drop_block"`, behind the
`thinking-binding-controls-2026-08-01` beta). This adds that to every reply
request that uses thinking. Remove it once Parlant handles this itself.
"""

from typing import Any

from parlant.adapters.nlp.anthropic_service import AnthropicReactGenerator

BETA = "thinking-binding-controls-2026-08-01"
_PATCHED = "_travel_agent_drop_stale_thinking"


def _with_block_binding(request: dict[str, Any]) -> dict[str, Any]:
    if "thinking" not in request:
        return request
    headers = dict(request.get("extra_headers") or {})
    betas = [b for b in headers.get("anthropic-beta", "").split(",") if b]
    headers["anthropic-beta"] = ",".join([*betas, BETA] if BETA not in betas else betas)
    return {
        **request,
        "thinking": {
            **request["thinking"],
            "block_binding": {"prefix_mismatch_behavior": "drop_block"},
        },
        "extra_headers": headers,
    }


def install() -> None:
    """Patches Parlant's Anthropic reply generator. Idempotent."""
    if getattr(AnthropicReactGenerator, _PATCHED, False):
        return
    encode = AnthropicReactGenerator._encode

    def _encode(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return _with_block_binding(encode(self, *args, **kwargs))

    AnthropicReactGenerator._encode = _encode  # type: ignore[method-assign]
    setattr(AnthropicReactGenerator, _PATCHED, True)
