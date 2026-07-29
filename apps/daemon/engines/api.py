"""APIEngine — Direct API calls to OpenAI/Anthropic."""

import asyncio
import json
import logging
import os
from typing import AsyncIterator

import httpx

from engines.base import BaseLLMEngine
from engines.events import InternalEvent

logger = logging.getLogger(__name__)


class APIEngine(BaseLLMEngine):
    """Engine that directly calls OpenAI/Anthropic API.

    Supports both OpenAI-compatible endpoints and Anthropic's native API.
    """

    def __init__(self):
        self._running = False
        self._client: httpx.AsyncClient | None = None

    # --- Engine discovery ---

    @staticmethod
    def is_installed() -> bool:
        """The HTTP adapter is usable only when credentials are configured."""
        return bool(os.environ.get("API_KEY") or os.environ.get("OPENAI_API_KEY"))

    @staticmethod
    def get_version() -> str | None:
        """Return API engine version."""
        return "1.0.0"

    @staticmethod
    def resolve_binary() -> str:
        """Return identifier for API engine."""
        return "api-engine"

    # --- Execution ---

    async def spawn(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
    ) -> AsyncIterator[InternalEvent]:
        """Call API and stream events."""
        self._running = True

        # Build request based on provider
        provider = os.environ.get("API_PROVIDER", "openai")
        api_key = os.environ.get("API_KEY", os.environ.get("OPENAI_API_KEY", ""))
        api_base = os.environ.get("API_BASE", "https://api.openai.com/v1")

        if not api_key:
            yield InternalEvent(type="error", data={"message": "API_KEY not set"})
            return

        # Determine model
        model = model or os.environ.get("API_MODEL", "gpt-4")
        if provider == "anthropic":
            model = model or "claude-3-sonnet-20240229"

        # Prepare messages
        messages = [{"role": "user", "content": prompt}]

        try:
            async with httpx.AsyncClient(
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                timeout=60.0,
            ) as client:
                self._client = client

                yield InternalEvent(type="status", data={"status": "running"})

                # Call API
                if provider == "anthropic":
                    events = await self._call_anthropic(client, model, messages)
                else:
                    # Default to OpenAI-compatible
                    events = await self._call_openai(client, model, messages)

                for event in events:
                    yield event

        except httpx.TimeoutException:
            yield InternalEvent(type="error", data={"message": "API request timeout"})
        except httpx.HTTPStatusError as e:
            yield InternalEvent(type="error", data={
                "message": f"API error: {e.response.status_code}",
                "detail": e.response.text,
            })
        except Exception as e:
            logger.exception("API engine error")
            yield InternalEvent(type="error", data={"message": str(e)})
        finally:
            self._running = False

    async def _call_openai(
        self,
        client: httpx.AsyncClient,
        model: str,
        messages: list[dict],
    ) -> list[InternalEvent]:
        """Call OpenAI-compatible API."""
        url = f"{os.environ.get('API_BASE', 'https://api.openai.com/v1')}/chat/completions"

        payload = {
            "model": model,
            "messages": messages,
            "stream": True,
        }

        # For non-streaming fallback
        stream = os.environ.get("API_STREAM", "true").lower() == "true"

        if stream:
            return await self._stream_openai(client, url, payload)
        else:
            return await self._call_openai_sync(client, url, payload)

    async def _stream_openai(
        self,
        client: httpx.AsyncClient,
        url: str,
        payload: dict,
    ) -> list[InternalEvent]:
        """Stream OpenAI responses."""
        events = []
        async with client.stream("POST", url, json=payload) as response:
            async for line in response.aiter_lines():
                if not line:
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                        event = self._map_openai_event(obj)
                        if event:
                            events.append(event)
                    except json.JSONDecodeError:
                        continue
        return events

    async def _call_openai_sync(
        self,
        client: httpx.AsyncClient,
        url: str,
        payload: dict,
    ) -> list[InternalEvent]:
        """Non-streaming OpenAI call."""
        response = await client.post(url, json=payload)
        obj = response.json()
        return self._map_openai_event(obj)

    def _map_openai_event(self, obj: dict) -> InternalEvent | None:
        """Map OpenAI API response to InternalEvent."""
        if "error" in obj:
            return InternalEvent(type="error", data=obj["error"])

        # Streaming response
        if obj.get("object") == "chat.completion.chunk":
            choices = obj.get("choices", [])
            for choice in choices:
                delta = choice.get("delta", {})
                if delta.get("content"):
                    return InternalEvent(type="text_delta", data={"delta": delta["content"]})

        # Full response
        if "choices" in obj:
            choice = obj["choices"][0].get("message", {})
            content = choice.get("content", "")
            if content:
                return InternalEvent(type="text_delta", data={"delta": content})

            # Check for tool calls
            tool_calls = choice.get("tool_calls", [])
            for tc in tool_calls:
                return InternalEvent(type="tool_use", data={
                    "name": tc.get("function", {}).get("name", ""),
                    "input": tc.get("function", {}).get("arguments", "{}"),
                })

        # Usage info
        if "usage" in obj:
            usage = obj["usage"]
            return InternalEvent(type="usage", data={
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
            })

        return None

    async def _call_anthropic(
        self,
        client: httpx.AsyncClient,
        model: str,
        messages: list[dict],
    ) -> list[InternalEvent]:
        """Call Anthropic API."""
        url = f"{os.environ.get('API_BASE', 'https://api.anthropic.com/v1')}/messages"

        # Convert OpenAI format to Anthropic format
        system = ""
        adjusted_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system = msg["content"]
            else:
                adjusted_messages.append(msg)

        payload = {
            "model": model,
            "messages": adjusted_messages,
            "stream": True,
        }

        if system:
            payload["system"] = system

        stream = os.environ.get("API_STREAM", "true").lower() == "true"

        if stream:
            return await self._stream_anthropic(client, url, payload)
        else:
            return await self._call_anthropic_sync(client, url, payload)

    async def _stream_anthropic(
        self,
        client: httpx.AsyncClient,
        url: str,
        payload: dict,
    ) -> list[InternalEvent]:
        """Stream Anthropic responses."""
        events = []
        headers = {
            "x-api-key": os.environ.get("API_KEY", ""),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        async with client.stream("POST", url, json=payload, headers=headers) as response:
            async for line in response.aiter_lines():
                if not line:
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                        event = self._map_anthropic_event(obj)
                        if event:
                            events.append(event)
                    except json.JSONDecodeError:
                        continue
        return events

    async def _call_anthropic_sync(
        self,
        client: httpx.AsyncClient,
        url: str,
        payload: dict,
    ) -> list[InternalEvent]:
        """Non-streaming Anthropic call."""
        headers = {
            "x-api-key": os.environ.get("API_KEY", ""),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        response = await client.post(url, json=payload, headers=headers)
        obj = response.json()
        return self._map_anthropic_event(obj)

    def _map_anthropic_event(self, obj: dict) -> InternalEvent | None:
        """Map Anthropic API response to InternalEvent."""
        if obj.get("type") == "message_start":
            return InternalEvent(type="status", data={"status": "running"})

        if obj.get("type") == "content_block_delta":
            if obj.get("delta", {}).get("type") == "text_delta":
                return InternalEvent(type="text_delta", data={"delta": obj["delta"]["text"]})

        if obj.get("type") == "content_block_start":
            if obj.get("content_block", {}).get("type") == "tool_use":
                block = obj["content_block"]
                return InternalEvent(type="tool_use", data={
                    "id": block.get("id", ""),
                    "name": block.get("name", ""),
                    "input": {},
                })

        if obj.get("type") == "content_block_stop":
            return InternalEvent(type="tool_result", data={"status": "completed"})

        if obj.get("type") == "message_delta":
            usage = obj.get("usage", {})
            if usage:
                return InternalEvent(type="usage", data={
                    "input_tokens": usage.get("input_tokens", 0),
                    "output_tokens": usage.get("output_tokens", 0),
                })

        if obj.get("type") == "message" and obj.get("status") == "completed":
            return InternalEvent(type="status", data={"status": "done"})

        return None

    # --- Interaction ---

    async def stop(self) -> None:
        """Cancel ongoing request."""
        if self._client:
            await self._client.aclose()
        self._running = False

    async def inject_response(self, tool_use_id: str, content: str) -> None:
        """Inject response to a tool use."""
        # API engine doesn't support mid-execution injection in this simple implementation
        logger.warning("inject_response not fully implemented for APIEngine")

    # --- Session resume ---

    @property
    def supports_resume(self) -> bool:
        return False  # API calls are stateless

    @property
    def supports_interactive(self) -> bool:
        return False

    def build_resume_params(self, session_id: str) -> dict:
        return {}
