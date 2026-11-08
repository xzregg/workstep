"""Bounded, async media I/O and project-relative chat references."""
import asyncio
import io
import mimetypes
from pathlib import Path
import re
import uuid
from urllib.parse import urlparse

import aiohttp

from services.channels.base import ChannelAttachment


async def fetch_media(url: str, limit: int, domains: tuple[str, ...], *, upgrade_http: bool = False) -> bytes:
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for _ in range(4):
            parsed = urlparse(url)
            host = parsed.hostname or ''
            trusted = any(host == domain or host.endswith('.'+domain) for domain in domains)
            # DingTalk can return legacy HTTP media URLs. Upgrade before any
            # request, including redirects, while retaining the signed query.
            if upgrade_http and trusted and parsed.scheme == 'http' and parsed.port in (None, 80):
                parsed = parsed._replace(scheme='https', netloc=host)
                url = parsed.geturl()
            if parsed.scheme != 'https' or not trusted or parsed.username or parsed.password or parsed.port not in (None, 443):
                raise ValueError(f'附件下载地址不是平台 HTTPS 地址（协议: {parsed.scheme}，域名: {host}）')
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
        candidate = Path(path)
        if candidate.parts[:1] == ('.workstep',):
            root = Path(getattr(project, 'workstep_dir', root/'.workstep')).resolve()
            candidate = Path(*candidate.parts[1:])
        file = (root / candidate).resolve()
        if not file.is_relative_to(root) or not file.is_file():
            raise ValueError('附件必须是项目内的文件')
        from engines.core.image_output import MAX_IMAGE_BYTES
        read_limit = max(limit, MAX_IMAGE_BYTES) if kind == 'image' else limit
        with file.open('rb') as stream:
            data = stream.read(read_limit + 1)
        if not data or len(data) > read_limit:
            raise ValueError('附件为空或超过渠道大小限制')
        mime = mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
        if kind == 'image' and not mime.startswith('image/'):
            raise ValueError('图片附件必须使用图片格式')
        name = file.name
        if kind == 'image' and len(data) > limit:
            data = _fit_channel_image(data, limit)
            name = file.stem + '.jpg'
            mime = 'image/jpeg'
        return ChannelAttachment(kind=kind, name=name, mime_type=mime, path=str(file), data=data)
    return await asyncio.to_thread(read)


def _fit_channel_image(data: bytes, limit: int) -> bytes:
    """Encode a delivery copy; the project's full resolution original is untouched."""
    from PIL import Image
    from engines.core.image_output import checked_image

    with checked_image(data) as source:
        # Flatten transparency onto white for channels' broadly supported JPEG.
        rgba = source.convert('RGBA')
        image = Image.new('RGB', rgba.size, 'white')
        image.paste(rgba, mask=rgba.getchannel('A'))
    for _ in range(9):
        for quality in (88, 72, 55):
            output = io.BytesIO()
            image.save(output, 'JPEG', quality=quality, optimize=True)
            if output.tell() <= limit:
                return output.getvalue()
        image = image.resize((max(1, image.width * 3 // 4), max(1, image.height * 3 // 4)))
    raise ValueError('图片压缩后仍超过渠道大小限制')


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


async def outgoing_content(project, adapter, text: str, attachments=(), *, file_links=None):
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
    from services.channels.file_links import ChannelFileLinks
    text = await (file_links or ChannelFileLinks(project)).convert(text)
    message = OutgoingMessage(text=text, attachments=tuple(media))
    adapter.validate_outgoing(message)
    return message
