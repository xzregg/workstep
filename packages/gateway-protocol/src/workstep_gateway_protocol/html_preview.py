"""Browser policy shared by the host and its public Gateway proxy."""

PREVIEW_RESOURCES_HEADER = 'X-WorkStep-Preview-Resources'
HTML_SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads'
STATIC_CDNS = ' '.join('https://' + host for host in (
    'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'esm.sh', 'unpkg.com',
    'fonts.bunny.net', 'fonts.googleapis.com', 'fonts.gstatic.com',
))


def preview_preflight_headers() -> dict[str, str]:
    return {'Access-Control-Allow-Origin': 'null', 'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Allow-Methods': 'GET',
            'Access-Control-Allow-Headers': 'x-workstep-desktop-token, content-type',
            'Cache-Control': 'no-store'}


def html_preview_policy(origin: str, resource_path: str | None = None) -> str:
    # Paths end with /: CSP then restricts requests to that capability's subtree.
    resource = origin.rstrip('/') + resource_path if resource_path else None
    assets = resource or ''
    return '; '.join((
        f'sandbox {HTML_SANDBOX}',
        "default-src 'none'",
        f"script-src 'unsafe-inline' 'unsafe-eval' blob: data: {assets} {STATIC_CDNS}",
        f"style-src 'unsafe-inline' blob: data: {assets} {STATIC_CDNS}",
        f"img-src data: blob: {assets} {STATIC_CDNS}",
        f"font-src data: blob: {assets} {STATIC_CDNS}",
        f"media-src data: blob: {assets}",
        f"connect-src {resource or chr(39) + 'none' + chr(39)}",
        "object-src 'none'", f"frame-src blob: data: {assets}", "worker-src 'none'",
        "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
    ))
