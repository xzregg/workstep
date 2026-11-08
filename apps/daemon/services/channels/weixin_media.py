"""iLink image/file CDN transport, bounded downloads and worker-side crypto."""
import asyncio
import base64
import hashlib
import secrets
from urllib.parse import urlencode, urlsplit

import httpx
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7

CDN_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
CDN_HOSTS = {'novac2c.cdn.weixin.qq.com', 'ilinkai.weixin.qq.com', 'wx.qlogo.cn',
             'thirdwx.qlogo.cn', 'res.wx.qq.com', 'mmbiz.qpic.cn', 'mmbiz.qlogo.cn'}


def checked_url(url):
    try:
        value = urlsplit(url)
        if (value.scheme == 'https' and value.hostname in CDN_HOSTS and value.port in (None, 443)
                and not value.username and not value.password):
            return url
    except ValueError:
        pass
    raise ValueError('微信 ClawBot 媒体地址无效')


def media_url(media):
    if media.get('encrypt_query_param'):
        return CDN_URL + '/download?' + urlencode({'encrypted_query_param': media['encrypt_query_param']})
    return checked_url(media.get('full_url') or '')


def encrypt(data, key):
    padder = PKCS7(128).padder()
    padded = padder.update(data) + padder.finalize()
    cipher = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return cipher.update(padded) + cipher.finalize()


def decrypt(data, key):
    cipher = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    padded = cipher.update(data) + cipher.finalize()
    unpadder = PKCS7(128).unpadder()
    return unpadder.update(padded) + unpadder.finalize()


def decode_key(value):
    key = base64.b64decode(value, validate=True)
    if len(key) == 32:
        key = bytes.fromhex(key.decode('ascii'))
    if len(key) != 16:
        raise ValueError('微信 ClawBot 媒体密钥无效')
    return key


async def download(api, attachment, limit):
    media = attachment.reference
    if media.get('encrypt_query_param') and not media.get('aes_key'):
        raise ValueError('微信 ClawBot 加密附件缺少密钥')
    try:
        client = await api.client()
        async with client.stream('GET', media_url(media), timeout=60) as response:
            response.raise_for_status()
            data = bytearray()
            async for part in response.aiter_bytes():
                data.extend(part)
                if len(data) > limit + 16:
                    raise ValueError('附件超过渠道大小限制')
        raw = bytes(data)
        if media.get('aes_key'):
            raw = await asyncio.to_thread(decrypt, raw, decode_key(media['aes_key']))
        if len(raw) > limit:
            raise ValueError('附件超过渠道大小限制')
        return raw, attachment.name
    except httpx.HTTPError:
        raise RuntimeError('微信 ClawBot 附件下载失败') from None


async def upload(api, recipient, attachment):
    key, filekey = secrets.token_bytes(16), secrets.token_hex(16)
    def prepare():
        return encrypt(attachment.data, key), hashlib.md5(attachment.data, usedforsecurity=False).hexdigest()
    ciphertext, digest = await asyncio.to_thread(prepare)
    data = await api.request('getuploadurl', payload={
        'filekey': filekey, 'media_type': 1 if attachment.kind == 'image' else 3,
        'to_user_id': recipient, 'rawsize': len(attachment.data), 'rawfilemd5': digest,
        'filesize': len(ciphertext), 'no_need_thumb': True, 'aeskey': key.hex(),
    })
    url = data.get('upload_full_url')
    if not url and data.get('upload_param'):
        url = CDN_URL + '/upload?' + urlencode({'encrypted_query_param': data['upload_param'], 'filekey': filekey})
    try:
        client = await api.client()
        response = await client.post(checked_url(url or ''), content=ciphertext,
                                    headers={'Content-Type': 'application/octet-stream'}, timeout=120)
        response.raise_for_status()
        query = response.headers.get('x-encrypted-param')
        if not query:
            raise RuntimeError('微信 ClawBot 附件上传未返回文件标识')
    except httpx.HTTPError:
        raise RuntimeError('微信 ClawBot 附件上传失败') from None
    media = {'encrypt_query_param': query, 'aes_key': base64.b64encode(key.hex().encode()).decode(), 'encrypt_type': 1}
    if attachment.kind == 'image':
        return {'type': 2, 'image_item': {'media': media, 'mid_size': len(ciphertext)}}
    return {'type': 4, 'file_item': {'media': media, 'file_name': attachment.name or 'attachment.bin', 'len': str(len(attachment.data))}}
