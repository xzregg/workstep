"""Port of official WecomTeam Node SDK's three-step media upload protocol.

The official Python SDK's public reply(frame, body, cmd) transports these commands.
"""
import asyncio
import base64
import hashlib
import uuid


async def upload_media(client, attachment) -> str:
    async def command(name, body):
        result = await client.reply({'headers': {'req_id': uuid.uuid4().hex}}, body, name)
        if result.get('errcode') not in (None, 0):
            raise RuntimeError('企业微信附件上传失败')
        return result.get('body') or {}
    chunk_size = 512 * 1024
    count = (len(attachment.data) + chunk_size - 1) // chunk_size
    md5 = await asyncio.to_thread(lambda: hashlib.md5(attachment.data).hexdigest())
    result = await command('aibot_upload_media_init', {
        'type': attachment.kind, 'filename': attachment.name, 'total_size': len(attachment.data),
        'total_chunks': count, 'md5': md5,
    })
    upload_id = result.get('upload_id')
    if not upload_id:
        raise RuntimeError('企业微信上传缺少 upload_id')
    for index in range(count):
        chunk = attachment.data[index*chunk_size:(index+1)*chunk_size]
        encoded = await asyncio.to_thread(lambda: base64.b64encode(chunk).decode('ascii'))
        for attempt in range(3):
            try:
                await command('aibot_upload_media_chunk', {'upload_id':upload_id,'chunk_index':index,'base64_data':encoded})
                break
            except Exception:
                if attempt == 2: raise
                await asyncio.sleep(.5 * (attempt+1))
    result = await command('aibot_upload_media_finish', {'upload_id':upload_id})
    if not result.get('media_id'):
        raise RuntimeError('企业微信上传缺少 media_id')
    return result['media_id']
