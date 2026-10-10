from typing import Literal
from urllib.parse import urlsplit, parse_qs

from pydantic import Field, field_validator, model_validator
from schemas.base import BaseSchema

NotificationEvent = Literal['started', 'completed', 'failed', 'paused', 'stopped', 'step_completed', 'step_failed', 'waiting']
EVENT_NAMES = {'started':'任务开始', 'completed':'任务完成', 'failed':'任务失败', 'paused':'任务暂停', 'stopped':'任务停止',
               'step_completed':'步骤完成', 'step_failed':'步骤失败', 'waiting':'步骤等待确认', 'test':'测试通知'}


class NotificationHookDraft(BaseSchema):
    id: str | None = Field(default=None, max_length=128)
    name: str = Field(min_length=1, max_length=128)
    platform: Literal['dingtalk', 'wecom', 'generic'] = 'generic'
    url: str = Field(min_length=1, max_length=4096)
    secret: str = Field(default='', max_length=1024)
    enabled: bool = True
    events: list[NotificationEvent] = Field(default_factory=lambda: ['completed','failed'], min_length=1, max_length=8)
    prefix: str = Field(default='', max_length=80)
    include_link: bool = True
    link_base: Literal['gateway','external','internal'] = 'gateway'

    @field_validator('name')
    @classmethod
    def name_required(cls, value):
        if not value.strip(): raise ValueError('名称不能为空')
        return value.strip()

    @model_validator(mode='after')
    def validate_target(self):
        self.url = self.url.strip()
        try:
            url = urlsplit(self.url)
            port = url.port
        except ValueError as exc:
            raise ValueError('Webhook 地址无效') from exc
        if url.scheme not in {'http','https'} or not url.hostname or url.username or url.password or url.fragment:
            raise ValueError('请输入无用户名和片段的 HTTP(S) 地址')
        if any(ord(c) < 33 for c in self.url): raise ValueError('地址不能包含空白或控制字符')
        if self.platform != 'generic':
            host, path, token = ('oapi.dingtalk.com','/robot/send','access_token') if self.platform == 'dingtalk' else ('qyapi.weixin.qq.com','/cgi-bin/webhook/send','key')
            if url.scheme != 'https' or url.hostname != host or url.path != path or port not in (None,443) or not parse_qs(url.query).get(token):
                raise ValueError('请输入所选平台的机器人 Webhook 地址')
        if self.platform != 'dingtalk': self.secret = ''
        self.events = list(dict.fromkeys(self.events))
        return self


class SaveNotificationHooks(BaseSchema):
    hooks: list[NotificationHookDraft] = Field(max_length=100)


class NotificationPreview(BaseSchema):
    hook: NotificationHookDraft
    event: NotificationEvent = 'completed'
    title: str = Field(default='示例任务', min_length=1, max_length=500)
    step: str = Field(default='示例步骤', max_length=128)
