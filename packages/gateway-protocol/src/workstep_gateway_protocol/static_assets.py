"""Compress static bundles without buffering application event streams."""
from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipMiddleware


class StaticAssetCompressionMiddleware:
    def __init__(self, app, *, prefixes=('/assets/', '/static/', '/landing/')):
        self.app = app
        self.prefixes = prefixes
        self.compressed = GZipMiddleware(app, minimum_size=1024, compresslevel=6)

    async def __call__(self, scope, receive, send):
        if (scope['type'] == 'http' and scope['method'] == 'GET'
                and (scope['path'].startswith(self.prefixes) or scope['path'] in ('/', '/index.html'))):
            headers = Headers(scope=scope)
            accepts_gzip = False
            for encoding in headers.get('accept-encoding', '').lower().split(','):
                name, *parameters = encoding.strip().split(';')
                if name.strip() != 'gzip':
                    continue
                quality = 1.0
                for parameter in parameters:
                    key, _, value = parameter.strip().partition('=')
                    if key == 'q':
                        try:
                            quality = float(value)
                        except ValueError:
                            quality = 0
                accepts_gzip = 0 < quality <= 1
            if accepts_gzip and 'range' not in headers:
                await self.compressed(scope, receive, send)
                return
        await self.app(scope, receive, send)
