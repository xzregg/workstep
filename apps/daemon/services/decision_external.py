"""Bounded read-only model discovery for Jev/OpenAI-compatible services."""
import asyncio
import json
import httpx


async def available_models(settings, transport=None):
    base = settings['base_url']
    url = base + ('/models' if base.endswith('/v1') else '/v1/models')
    headers = {'Authorization': f"Bearer {settings['api_key']}"} if settings['api_key'] else {}
    try:
        async with asyncio.timeout(20), httpx.AsyncClient(headers=headers, transport=transport,
                timeout=15, follow_redirects=False) as client:
            async with client.stream('GET', url) as response:
                if response.status_code in (401, 403):
                    raise ValueError('读取模型列表认证失败，请检查访问密钥；也可手动填写模型')
                if response.status_code in (404, 405):
                    raise ValueError('服务不支持读取模型列表，请手动填写模型')
                response.raise_for_status()
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(data) + len(chunk) > 1024 * 1024:
                        raise ValueError('模型列表响应过大，请手动填写模型')
                    data.extend(chunk)
                def parse():
                    value = json.loads(data)
                    rows = value.get('data', value.get('models')) if isinstance(value, dict) else value
                    if not isinstance(rows, list) or len(rows) > 1000:
                        raise ValueError('模型列表格式无效或超过 1000 项，请手动填写模型')
                    models = set()
                    for row in rows:
                        name = row.get('id') if isinstance(row, dict) else row
                        if not isinstance(name, str) or not name.strip() or len(name) > 256 or any(c in name for c in '\r\n\x00'):
                            raise ValueError('模型列表格式无效，请手动填写模型')
                        models.add(name.strip())
                    return {'models': sorted(models, key=str.casefold)}
                return await asyncio.to_thread(parse)
    except asyncio.CancelledError:
        raise
    except (json.JSONDecodeError, UnicodeDecodeError, RecursionError):
        raise ValueError('模型列表格式无效，请手动填写模型') from None
    except ValueError:
        raise
    except Exception:
        raise ValueError('无法读取模型列表，请检查服务地址或网络；也可手动填写模型') from None
