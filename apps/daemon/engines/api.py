"""APIEngine — Direct API calls to OpenAI/Anthropic."""

import asyncio
import json
import logging
from typing import AsyncIterator

import httpx

from engines.base import BaseLLMEngine, EngineModel
from engines.events import InternalEvent, normalize_token_usage
from services.config import config_store

logger = logging.getLogger(__name__)


class APIEngine(BaseLLMEngine):
    """Engine that directly calls OpenAI/Anthropic API.

    Supports both OpenAI-compatible endpoints and Anthropic's native API.
    """

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None):
        self._running = False
        self._client: httpx.AsyncClient | None = None
        self._transport = transport

    # --- Engine discovery ---

    @staticmethod
    def is_installed() -> bool:
        """The HTTP adapter ships with WorkStep."""
        return True

    @staticmethod
    def is_configured() -> bool:
        config = config_store.get_api_engine_config()
        return bool(config["base_url"] and config["model"])

    @staticmethod
    def get_version() -> str | None:
        """Return API engine version."""
        return "1.0.0"

    @staticmethod
    def resolve_binary() -> str:
        """Return identifier for API engine."""
        return "api-engine"

    async def list_models(self, cwd: str) -> list[EngineModel]:
        config = config_store.get_api_engine_config()
        return await self.list_models_for_config(
            provider=config["provider"],
            base_url=config["base_url"],
            api_key=config["api_key"],
        )

    async def list_models_for_config(
        self,
        *,
        provider: str,
        base_url: str,
        api_key: str,
    ) -> list[EngineModel]:
        headers = {"Accept": "application/json"}
        if provider == "anthropic":
            if api_key:
                headers["x-api-key"] = api_key
            headers["anthropic-version"] = "2023-06-01"
        elif api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        async with httpx.AsyncClient(
            headers=headers,
            timeout=15,
            transport=self._transport,
        ) as client:
            response = await client.get(f"{base_url.rstrip('/')}/models")
            response.raise_for_status()
            payload = response.json()

        items = payload.get("data", []) if isinstance(payload, dict) else []
        models = {}
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                continue
            model_id = item["id"]
            label = item.get("display_name") or item.get("name") or model_id
            models[model_id] = EngineModel(
                id=model_id,
                label=str(label),
                description=(
                    str(item["owned_by"])
                    if item.get("owned_by") is not None
                    else None
                ),
            )
        return sorted(models.values(), key=lambda item: item.label.lower())

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

        config = config_store.get_api_engine_config()
        provider = config["provider"]
        api_key = config["api_key"]
        api_base = config["base_url"].rstrip("/")

        if not api_base or not (model or config["model"]):
            yield InternalEvent(type="error", data={
                "message": "API / BYOK 尚未配置 API 地址和模型"
            })
            return

        model = model or config["model"]

        # Prepare messages
        messages = [{"role": "user", "content": prompt}]
        headers = {"Content-Type": "application/json"}
        if provider == "openai" and api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        try:
            async with httpx.AsyncClient(
                headers=headers,
                timeout=60.0,
                transport=self._transport,
            ) as client:
                self._client = client

                yield InternalEvent(type="status", data={"status": "running"})

                # Call API
                if provider == "anthropic":
                    events = await self._call_anthropic(
                        client, model, messages, api_base, api_key
                    )
                else:
                    # Default to OpenAI-compatible
                    events = await self._call_openai(
                        client, model, messages, api_base
                    )

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
        api_base: str,
    ) -> list[InternalEvent]:
        """Call OpenAI-compatible API."""
        url = f"{api_base}/chat/completions"

        payload = {
            "model": model,
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
        }

        # For non-streaming fallback
        try:
            return await self._stream_openai(client, url, payload)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code not in {400, 422}:
                raise
            logger.info(
                "OpenAI-compatible endpoint rejected stream_options; retrying without it"
            )
            payload.pop("stream_options", None)
            return await self._stream_openai(client, url, payload)

    async def _stream_openai(
        self,
        client: httpx.AsyncClient,
        url: str,
        payload: dict,
    ) -> list[InternalEvent]:
        """Stream OpenAI responses."""
        events = []
        async with client.stream("POST", url, json=payload) as response:
            response.raise_for_status()
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
        response.raise_for_status()
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
                thinking = delta.get("reasoning_content") or delta.get("reasoning")
                if thinking:
                    return InternalEvent(
                        type="thinking_delta",
                        data={"delta": thinking},
                    )
                if delta.get("content"):
                    return InternalEvent(type="text_delta", data={"delta": delta["content"]})

        # Full response
        choices = obj.get("choices", [])
        if choices:
            choice = choices[0].get("message", {})
            thinking = choice.get("reasoning_content") or choice.get("reasoning")
            if thinking:
                return InternalEvent(
                    type="thinking_delta",
                    data={"delta": thinking},
                )
            content = choice.get("content", "")
            if content:
                return InternalEvent(type="text_delta", data={"delta": content})

            # Check for tool calls
            tool_calls = choice.get("tool_calls", [])
            for tc in tool_calls:
                return InternalEvent(type="tool_use", data={
                    "id": tc.get("id", ""),
                    "name": tc.get("function", {}).get("name", ""),
                    "input": tc.get("function", {}).get("arguments", "{}"),
                })

        # Usage info
        usage = obj.get("usage")
        if isinstance(usage, dict):
            details = usage.get("prompt_tokens_details", {}) or {}
            return InternalEvent(
                type="usage",
                data=normalize_token_usage({
                    **usage,
                    "cached_tokens": details.get("cached_tokens", 0),
                }),
            )

        return None

    async def _call_anthropic(
        self,
        client: httpx.AsyncClient,
        model: str,
        messages: list[dict],
        api_base: str,
        api_key: str,
    ) -> list[InternalEvent]:
        """Call Anthropic API."""
        url = f"{api_base}/messages"

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
            "max_tokens": 4096,
        }

        if system:
            payload["system"] = system

        return await self._stream_anthropic(client, url, payload, api_key)

    async def _stream_anthropic(
        self,
        client: httpx.AsyncClient,
        url: str,
        payload: dict,
        api_key: str,
    ) -> list[InternalEvent]:
        """Stream Anthropic responses."""
        events = []
        usage_data = {}
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        async with client.stream("POST", url, json=payload, headers=headers) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line:
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                        usage_data.update(self._anthropic_usage_payload(obj))
                        event = self._map_anthropic_event(obj)
                        if event and event.type != "usage":
                            events.append(event)
                    except json.JSONDecodeError:
                        continue
        if usage_data:
            events.append(InternalEvent(
                type="usage",
                data=normalize_token_usage(usage_data),
            ))
        return events

    @staticmethod
    def _anthropic_usage_payload(obj: dict) -> dict:
        if obj.get("type") == "message_start":
            usage = obj.get("message", {}).get("usage", {})
        else:
            usage = obj.get("usage", {})
        if not isinstance(usage, dict):
            return {}
        keys = {
            "input_tokens",
            "output_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        }
        return {key: usage[key] for key in keys if key in usage}

    async def _call_anthropic_sync(
        self,
        client: httpx.AsyncClient,
        url: str,
        payload: dict,
        api_key: str,
    ) -> list[InternalEvent]:
        """Non-streaming Anthropic call."""
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        response = await client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        obj = response.json()
        return self._map_anthropic_event(obj)

    def _map_anthropic_event(self, obj: dict) -> InternalEvent | None:
        """Map Anthropic API response to InternalEvent."""
        if obj.get("type") == "message_start":
            return InternalEvent(type="status", data={"status": "running"})

        if obj.get("type") == "content_block_delta":
            if obj.get("delta", {}).get("type") == "text_delta":
                return InternalEvent(type="text_delta", data={"delta": obj["delta"]["text"]})
            if obj.get("delta", {}).get("type") == "thinking_delta":
                return InternalEvent(
                    type="thinking_delta",
                    data={"delta": obj["delta"].get("thinking", "")},
                )

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
                return InternalEvent(
                    type="usage",
                    data=normalize_token_usage(usage),
                )

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
