import inspect

from parlant.adapters.nlp.anthropic_service import AnthropicReactGenerator

from travel_agent import anthropic_thinking
from travel_agent.anthropic_thinking import BETA, _with_block_binding


def test_patches_the_method_parlant_builds_requests_with():
    # Guards the workaround against a Parlant upgrade renaming the method.
    assert "def _encode" in inspect.getsource(AnthropicReactGenerator)
    anthropic_thinking.install()
    anthropic_thinking.install()
    assert getattr(AnthropicReactGenerator, anthropic_thinking._PATCHED)


def test_lets_the_api_drop_stale_thinking_blocks():
    request = {"model": "m", "thinking": {"type": "adaptive", "display": "summarized"}}
    patched = _with_block_binding(request)
    assert patched["thinking"] == {
        "type": "adaptive",
        "display": "summarized",
        "block_binding": {"prefix_mismatch_behavior": "drop_block"},
    }
    assert patched["extra_headers"] == {"anthropic-beta": BETA}
    assert _with_block_binding(patched)["extra_headers"] == {"anthropic-beta": BETA}
    assert "thinking" not in request["thinking"]  # the original is untouched


def test_leaves_requests_without_thinking_alone():
    request = {"model": "m", "tool_choice": {"type": "any"}}
    assert _with_block_binding(request) is request
