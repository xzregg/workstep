"""Bounded, async media I/O and project-relative chat references."""
import asyncio
import mimetypes
from pathlib import Path
import re
import uuid
from urllib.parse import urlparse

import aiohttp

from services.channels.base import ChannelAttachment


async def fetch_media(url: str, limit: int, domains: tuple[str, ...]) -> bytes:
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for _ in range(4):
            parsed = urlparse(url)
            host = parsed.hostname or ''
            if parsed.scheme != 'https' or not any(host == domain or host.endswith('.'+domain) for domain in domains):
                raise ValueError('附件下载地址不是平台 HTTPS 地址')
            async with session.get(url, allow_redirects=False) as response:
                if response.status in (301,302,303,307,308):
                    from urllib.parse import urljoin
                    url = urljoin(url, response.headers['Location'])
                    continue
                response.raise_for_status()
                data = bytearray()
                async for chunk in response.content.iter_chunked(64*1024):
                    data.extend(chunk)
                    if len(data) > limit:
                        raise ValueError('附件超过渠道大小限制')
                return bytes(data)
    raise ValueError('附件下载重定向过多')


def safe_name(name: str, kind: str) -> str:
    name = Path(name.replace('\\', '/')).name
    name = re.sub(r'[^\w.\-]', '_', name).strip('. ')[:120]
    return name or ('image.png' if kind == 'image' else 'attachment.bin')


async def load_outgoing_attachment(project, kind: str, path: str, limit: int) -> ChannelAttachment:
    def read():
        root = Path(project.path).resolve()
        file = (root / path).resolve()
        if not file.is_relative_to(root) or not file.is_file():
            raise ValueError('附件必须是项目内的文件')
        with file.open('rb') as stream:
            data = stream.read(limit + 1)
        if not data or len(data) > limit:
            raise ValueError('附件为空或超过渠道大小限制')
        mime = mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
        if kind == 'image' and not mime.startswith('image/'):
            raise ValueError('图片附件必须使用图片格式')
        return ChannelAttachment(kind=kind, name=file.name, mime_type=mime, path=str(file), data=data)
    return await asyncio.to_thread(read)


async def _incoming_parts(project, adapter, text, attachments) -> str:
    parts = [text] if text else []
    for attachment in attachments:
        data, filename = await adapter.download(attachment)
        if not data or len(data) > adapter.CAPABILITIES.limit(attachment.kind):
            raise ValueError('附件为空或超过渠道大小限制')
        name = safe_name(filename or attachment.name, attachment.kind)
        storage_name = f'channel-{uuid.uuid4().hex}-{name}'
        def save():
            uploads = (Path(project.workstep_dir) / 'uploads').resolve()
            if not uploads.is_relative_to(Path(project.path).resolve()):
                raise ValueError('项目上传目录不能指向项目之外')
            uploads.mkdir(parents=True, exist_ok=True)
            (uploads / storage_name).write_bytes(data)
        await asyncio.to_thread(save)
        path = '.workstep/uploads/' + storage_name
        label = name.replace('[','_').replace(']','_')
        # Generated storage names contain no URL-reserved characters except spaces.
        parts.append(f'{"!" if attachment.kind == "image" else ""}[{label}]({path})')
    return '\n\n'.join(parts)


async def incoming_content(project, adapter, message) -> str:
    current = await _incoming_parts(project, adapter, message.text, message.attachments)
    if message.quote is None:
        return current
    quoted = await _incoming_parts(project, adapter, message.quote.text, message.quote.attachments)
    if not quoted:
        return current
    # Quote every line so the UI and model can distinguish it from this request.
    quoted = '\n'.join('> ' + line for line in quoted.splitlines())
    return f'引用消息：\n{quoted}\n\n本次消息：\n{current}'


async def outgoing_content(project, adapter, text: str, attachments=()):
    """Prepare project attachments; keep public links as text."""
    from services.channels.base import OutgoingMessage
    media = []
    for spec in attachments:
        media.append(await load_outgoing_attachment(project, spec['kind'], spec['path'], adapter.CAPABILITIES.limit(spec['kind'])))
    pattern = re.compile(r'(!?)\[([^\]]*)\]\(([^)]+)\)')
    seen = {attachment.path for attachment in media}
    replacements = []
    for match in pattern.finditer(text):
        target = match.group(3)
        if not target.startswith(('.workstep/uploads/', '.workstep/artifacts/')):
            continue
        kind = 'image' if match.group(1) else 'file'
        attachment = await load_outgoing_attachment(project, kind, target, adapter.CAPABILITIES.limit(kind))
        if attachment.path not in seen:
            media.append(attachment)
            seen.add(attachment.path)
        replacements.append((match.start(), match.end(), match.group(2) or attachment.name))
    for start,end,label in reversed(replacements):
        text = text[:start] + label + text[end:]
    message = OutgoingMessage(text=text, attachments=tuple(media))
    adapter.validate_outgoing(message)
    return message
