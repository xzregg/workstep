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
                    raise ValueError('Failed to authenticate when reading the model list. Please check your access key; you can also manually enter the model.')
                if response.status_code in (404, 405):
                    raise ValueError('Service does not support reading the model list, please manually fill in the model')
                response.raise_for_status()
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(data) + len(chunk) > 1024 * 1024:
                        raise ValueError('The model list response is too large, please manually fill in the model')
                    data.extend(chunk)
                def parse():
                    value = json.loads(data)
                    rows = value.get('data', value.get('models')) if isinstance(value, dict) else value
                    if not isinstance(rows, list) or len(rows) > 1000:
                        raise ValueError('Invalid model list format or exceeds 1000 items, please manually enter the model')
                    models = set()
                    for row in rows:
                        name = row.get('id') if isinstance(row, dict) else row
                        if not isinstance(name, str) or not name.strip() or len(name) > 256 or any(c in name for c in '\r\n\x00'):
                            raise ValueError('Invalid model list format, please fill in the model manually')
                        models.add(name.strip())
                    return {'models': sorted(models, key=str.casefold)}
                return await asyncio.to_thread(parse)
    except asyncio.CancelledError:
        raise
    except (json.JSONDecodeError, UnicodeDecodeError, RecursionError):
        raise ValueError('Invalid model list format, please fill in the model manually') from None
    except ValueError:
        raise
    except Exception:
        raise ValueError('Unable to read the model list. Please check the service address or network; you can also manually enter the model.') from None
