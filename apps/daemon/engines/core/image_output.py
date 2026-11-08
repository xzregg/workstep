"""Materialize native image output before persistence, replay, and delivery."""
import asyncio
import base64
import hashlib
import io
from pathlib import Path

from engines.core.events import InternalEvent, agent_message_chunk

MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000


def contains_image(value):
    if isinstance(value, list):
        return any(contains_image(part) for part in value)
    if isinstance(value, dict):
        return value.get('type') == 'image' or any(
            contains_image(value.get(key)) for key in ('content', 'content_items')
        )
    return False


def checked_image(data):
    from PIL import Image

    image = Image.open(io.BytesIO(data))
    if image.width * image.height > MAX_IMAGE_PIXELS:
        image.close()
        raise ValueError('图片像素过大')
    return image


class ImageOutputNormalizer:
    """One execution's image deduplication; all decoding and file I/O off-thread."""

    def __init__(self, storage_root, cwd):
        self.storage_root = Path(storage_root)
        self.cwd = Path(cwd)
        self.seen = set()

    def _save(self, block):
        source = block.get('source') or block
        encoded = source.get('data') or block.get('result')
        if encoded:
            if not isinstance(encoded, str) or len(encoded) > (MAX_IMAGE_BYTES + 2) // 3 * 4:
                raise ValueError('图片数据过大')
            data = base64.b64decode(encoded, validate=True)
        else:
            saved = block.get('savedPath') or block.get('saved_path')
            if not saved:
                raise ValueError('图片未返回内容')
            path = Path(saved)
            path = (self.cwd / path).resolve()
            allowed = [self.cwd.resolve(), (Path.home()/'.codex/generated_images').resolve()]
            if not any(path.is_relative_to(root) for root in allowed):
                raise ValueError('图片路径不在允许的输出目录')
            with path.open('rb') as stream:
                data = stream.read(MAX_IMAGE_BYTES + 1)
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ValueError('图片为空或过大')
        with checked_image(data) as image:
            extension = {'PNG': 'png', 'JPEG': 'jpg', 'WEBP': 'webp', 'GIF': 'gif'}.get(image.format)
            if not extension:
                raise ValueError('图片格式不受支持')
            image.verify()
        name = f'generated-{hashlib.sha256(data).hexdigest()}.{extension}'
        root = self.storage_root.resolve()
        uploads = root/'uploads'
        if uploads.is_symlink() or not uploads.resolve().is_relative_to(root):
            raise ValueError('图片输出目录无效')
        uploads.mkdir(parents=True, exist_ok=True)
        target = uploads/name
        if target.is_symlink():
            raise ValueError('图片输出文件无效')
        # Exclusive creation avoids overwriting existing content or following a link.
        try:
            with target.open('xb') as stream:
                stream.write(data)
        except FileExistsError:
            if target.read_bytes() != data:
                raise ValueError('图片输出文件冲突')
        return f'.workstep/uploads/{name}'

    async def normalize(self, event):
        links = []
        errors = []

        async def materialize(block):
            try:
                path = await asyncio.to_thread(self._save, block)
            except (ValueError, OSError, SyntaxError):
                errors.append('图片未能保存，请重新生成或提供可用的图片文件。')
                return {'type': 'text', 'text': '[图片保存失败]'}
            if path not in self.seen:
                self.seen.add(path)
                links.append(f'![生成的图片]({path})')
            return {'type': 'text', 'text': f'![生成的图片]({path})'}

        async def blocks(value):
            if isinstance(value, list):
                return [await blocks(part) for part in value]
            if not isinstance(value, dict):
                return value
            if value.get('type') == 'image' and (value.get('data') or isinstance(value.get('source'), dict) and value['source'].get('type') == 'base64'):
                return await materialize(value)
            # Only content containers, never tool inputs or arbitrary nested metadata.
            return {key: await blocks(part) if key in {'content', 'content_items'} else part
                    for key, part in value.items()}

        data = dict(event.data)
        if event.type == 'acp_raw':
            raw = data.get('raw') or {}
            item = raw.get('item') or {}
            if item.get('type') not in {'imageGeneration', 'image_generation'}:
                return [event]
            status = item.get('status')
            if status != 'completed':
                return [event]
            replacement = await materialize(item)
            data['raw'] = {**raw, 'item': {**item, 'result': '', 'content': replacement}}
        elif event.type == 'agent_message_chunk':
            is_image = contains_image(data.get('content'))
            data['content'] = await blocks(data.get('content'))
            if links or errors:
                # The image itself is the message; don't also append it below.
                return [agent_message_chunk('\n\n' + '\n\n'.join(links + errors) + '\n\n', phase='final_answer')]
            if is_image and data['content'].get('type') == 'text':
                return []
        elif event.type in {'tool_call', 'tool_call_update'} and data.get('status') != 'failed':
            for key in ('content', 'raw_output'):
                if key in data:
                    data[key] = await blocks(data[key])
        else:
            return [event]
        result = [InternalEvent(event.type, data, timestamp=event.timestamp)]
        if links or errors:
            result.append(agent_message_chunk('\n\n' + '\n\n'.join(links + errors) + '\n\n', phase='final_answer'))
        return result
