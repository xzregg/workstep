"""Public channel diagnostics use fixed text, never exception payloads."""

import asyncio
import logging
import re

import aiohttp
import httpx

from agent_assistants.session_state import PROVIDER_HANDOFF_REQUIRED

logger = logging.getLogger(__name__)


async def send_failure_notice(adapter, recipient, text: str) -> bool:
    observe = getattr(adapter, "observe_reply", None)
    if observe:
        try:
            observe(recipient, {"type": "TEXT_MESSAGE_END", "status": "failed"})
        except Exception:
            logger.warning("Failed to mark channel reply as failed", exc_info=True)
    try:
        from services.channels.base import ChannelAdapter
        send = adapter.send_failure_notice if isinstance(adapter, ChannelAdapter) else adapter.send_text
        await asyncio.wait_for(send(recipient, text), timeout=30)
    except Exception:
        logger.exception("Failed to send channel failure notice for %s message %s",
                         recipient.bot_id, recipient.message_id)
        return False
    return True


class AssistantReplyError(RuntimeError):
    """The assistant reached a failed terminal state."""


class ReplyWaitTimeout(TimeoutError):
    """No terminal message arrived within the channel's wait window."""


class ChannelTransportError(RuntimeError):
    def __init__(self, reason: str, *, status: int | None = None, code: int | None = None):
        self.reason = reason
        self.status = status
        self.code = code
        super().__init__(f"Channel API request failed ({reason}, HTTP status={status}, platform code={code})")

    @classmethod
    def from_http_error(cls, exc):
        if isinstance(exc, httpx.TimeoutException):
            return cls("timeout")
        if isinstance(exc, httpx.HTTPStatusError):
            return cls("http_status", status=exc.response.status_code)
        if isinstance(exc, (httpx.NetworkError, httpx.RemoteProtocolError)):
            return cls("connection")
        if isinstance(exc, (httpx.DecodingError, ValueError)):
            return cls("invalid_response")
        return cls("unknown")


def failure_notice(exc: Exception, stage: str, *, task: bool = False) -> str:
    detail = str(exc)
    if detail == PROVIDER_HANDOFF_REQUIRED and stage != "delivery":
        if task:
            return "协调供应商已变更。发送 /new 加上你的问题，即可在本群开启新的协调上下文。"
        return ("供应商已变更。请在工作台打开此渠道会话，选择新供应商并确认智能交接，再回这里继续。"
                "也可以发送 /new 加上你的问题，直接从新的上下文开始。")
    if stage == "delivery":
        reason = _delivery_reason(exc)
        return f"回复已生成，但渠道发送失败。{reason}请在 WorkStep 查看已生成的回复。"
    if isinstance(exc, ReplyWaitTimeout):
        return "等待助手回复超时。处理可能仍在继续，请在 WorkStep 查看会话状态。"
    if stage == "execution":
        if detail == "Quota exceeded. Check your plan and billing details.":
            return "模型执行失败，供应商额度不足。请检查模型供应商的额度和账单，再重试。"
        if detail == "供应商连接超时":
            return "模型执行失败，供应商连接超时。请检查供应商连接后重试。"
        if re.fullmatch(r"引擎空闲超时（[0-9]+s 无输出），.*", detail, re.DOTALL):
            return "模型执行超时，长时间没有输出。请在 WorkStep 查看会话状态后重试。"
        if re.fullmatch(r"Engine unavailable: [\w.-]+|Engine '[\w.-]+' not available", detail):
            return "助手执行失败，配置的引擎不可用。请在 WorkStep 检查引擎设置。"
        return "助手执行失败，原因未确认。请在 WorkStep 查看会话详情。"
    if detail == "Project not found":
        return "消息处理失败，绑定的项目不存在。请在 WorkStep 检查机器人绑定。"
    if detail == "Task not found":
        return "消息处理失败，绑定的任务不存在。请在 WorkStep 检查机器人绑定。"
    if detail == "Attachment is empty or exceeds channel size limit":
        return "消息处理失败，附件为空或超过渠道大小限制。请换一个较小的附件后重发。"
    return "消息处理失败，原因未确认。请在 WorkStep 查看会话状态。"


def _delivery_reason(exc: Exception) -> str:
    if isinstance(exc, ChannelTransportError):
        status, reason = exc.status, exc.reason
    elif isinstance(exc, httpx.HTTPStatusError):
        status, reason = exc.response.status_code, ""
    elif isinstance(exc, aiohttp.ClientResponseError):
        status, reason = exc.status, ""
    else:
        status, reason = None, ""
    if isinstance(exc, (TimeoutError, httpx.TimeoutException)) or reason == "timeout":
        return "渠道请求超时，送达状态未确认。"
    if reason == "expired":
        return "微信 ClawBot 登录已失效，请重新扫码。"
    if status in (401, 403) or reason == "authentication":
        return "渠道拒绝了认证或发送权限，请检查机器人连接和权限。"
    if status == 429:
        return "渠道触发发送限流，请稍后再试。"
    if status is not None and 500 <= status <= 599:
        return "渠道服务暂时异常，请稍后再试。"
    if reason == "connection" or isinstance(exc, (httpx.NetworkError, httpx.RemoteProtocolError, aiohttp.ClientConnectionError)):
        return "渠道连接中断或不可达，送达状态未确认。请检查网络和机器人连接。"
    if str(exc) in {"WeCom bot not connected", "The bot is disabled or disconnected",
                    "WebSocket not connected, unable to send data"}:
        return "机器人未连接，请在 WorkStep 检查机器人状态。"
    if re.fullmatch(r"Reply ack error: errcode=-?[0-9]+, errmsg=.*", str(exc), re.DOTALL):
        return "渠道拒绝了发送请求，请检查机器人连接和发送权限。"
    if str(exc) == "QQ passive reply count exhausted, please check results in WorkStep":
        return "已用完这条 QQ 消息的可回复次数。"
    if reason == "invalid_response":
        return "渠道返回了无法确认的响应，送达状态未确认。"
    if reason == "rejected" or status is not None and 400 <= status <= 499:
        return "渠道拒绝了发送请求，请检查机器人连接和发送权限。"
    if str(exc) in {
        "The attachment must be a file within the project",
        "Attachment is empty or exceeds channel size limit",
        "Image attachments must use image formats",
        "Image compression still exceeds channel size limit",
    }:
        return "回复附件无效或超出渠道限制。"
    return "送达失败的具体原因未确认。"
