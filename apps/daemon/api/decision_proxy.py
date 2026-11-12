"""Inference-only ASGI boundary; credentials never authorize host management.

Only these two exact method/path pairs bypass desktop/browser authentication.
They always require the existing remote access password or explicit access token,
including on loopback. Admission precedes disk reads and streaming body parsing.
"""
import asyncio
import json

from starlette.requests import Request, ClientDisconnect
from starlette.responses import JSONResponse

PREFIX = '/api/decision-models/v1'
MAX_BODY = 65536
from services.decision_catalog import DEFAULT_MODEL, MODELS


def validate_payload(value):
    if not isinstance(value, dict) or set(value) - {'state', 'questions', 'model'}:
        raise ValueError
    if 'model' in value and value['model'] not in [m['id'] for m in MODELS] + ['multilingual']:
        raise ValueError
    state, questions = value.get('state'), value.get('questions')
    if not isinstance(state, str) or not state.strip() or len(state) > 16000:
        raise ValueError
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 8:
        raise ValueError
    for key, question in questions.items():
        if not isinstance(key, str) or not 1 <= len(key) <= 128 or not isinstance(question, dict):
            raise ValueError
        if question.get('type') not in ('noul', 'choice', 'score'):
            raise ValueError
        if not isinstance(question.get('instructions'), str) or not 1 <= len(question['instructions']) <= 2048:
            raise ValueError
        # SDK owns question semantics; serialized size also bounds nested options.
        if len(json.dumps(question)) > 4096:
            raise ValueError
    return {'state': state, 'questions': questions, **({'model': DEFAULT_MODEL if value['model'] == 'multilingual' else value['model']} if 'model' in value else {})}


class DecisionProxyMiddleware:
    def __init__(self, app, *, service):
        self.app, self.service = app, service
        self.admission = asyncio.Lock()

    def _authorized(self, request):
        service = self.service
        settings = service._settings()
        remote = service.remote_access
        if not settings.get('proxy_enabled') or settings['mode'] != 'managed' or remote is None:
            return 503
        if not remote.access_password_required():
            return 503
        bearer = request.headers.get('authorization', '')
        key = bearer[7:] if bearer.lower().startswith('bearer ') else ''
        token = request.headers.get('x-workstep-access', '')
        if len(key) > 4096 or len(token) > 4096:
            return 401
        return 200 if ((key and remote.verify_access_password(key)) or
                       (token and remote.verify_access_token(token))) else 401

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or (scope['method'], scope['path']) not in (
                ('POST', PREFIX + '/systemone'), ('GET', PREFIX + '/models')):
            return await self.app(scope, receive, send)
        if self.admission.locked():
            return await JSONResponse({'detail': '本地推理繁忙，请稍后重试'}, 429,
                                      headers={'Retry-After': '1'})(scope, receive, send)
        async with self.admission:
            request = Request(scope, receive)
            try:
                status = await asyncio.to_thread(self._authorized, request)
            except (ValueError, TypeError):
                status = 401
            except Exception:
                status = 503
            if status != 200:
                response = JSONResponse({'detail': '需要访问密钥' if status == 401 else '本地代理未就绪'}, status)
            elif scope['method'] == 'GET':
                response = JSONResponse({'object': 'list', 'data': [{'id': self.service._settings().get('managed_model', DEFAULT_MODEL), 'object': 'model', 'owned_by': 'local'}]})
            else:
                response = await self._infer(request)
            response.headers['Cache-Control'] = 'no-store'
            await response(scope, receive, send)

    async def _infer(self, request):
        try:
            if int(request.headers.get('content-length', '0')) > MAX_BODY:
                return JSONResponse({'detail': '请求最大 64 KiB'}, 413)
            data = bytearray()
            async with asyncio.timeout(5):
                async for chunk in request.stream():
                    if len(data) + len(chunk) > MAX_BODY:
                        return JSONResponse({'detail': '请求最大 64 KiB'}, 413)
                    data.extend(chunk)
            payload = await asyncio.to_thread(lambda: validate_payload(json.loads(data)))
        except (ValueError, TypeError, RecursionError, ClientDisconnect):
            return JSONResponse({'detail': '无效请求：需包含 state 和 1–8 个 questions'}, 422)
        except TimeoutError:
            return JSONResponse({'detail': '请求读取超时'}, 408)
        try:
            result = await self.service.infer(payload)
            return JSONResponse(result)
        except LookupError:
            return JSONResponse({'detail': '请求模型与当前启用模型不一致'}, 422)
        except BlockingIOError:
            return JSONResponse({'detail': '本地推理繁忙，请稍后重试'}, 429, headers={'Retry-After': '1'})
        except Exception:
            return JSONResponse({'detail': '本地推理未就绪，请检查资源或重试'}, 503)
