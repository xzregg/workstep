"""Native image content shared by the Claude CLI and Agent SDK adapters."""

from engines.core.schema import EngineImage


def build_claude_user_content(
    prompt: str, images: list[EngineImage] | None,
) -> str | list[dict]:
    """Preserve the text and attach images as Anthropic content blocks.

    Local image reads must run in a worker thread at the call site.
    """
    if not images:
        return prompt
    content = [{"type": "text", "text": prompt}]
    for image in images:
        reference = image.to_data_url()
        if reference.startswith("data:"):
            header, data = reference.split(",", 1)
            if not header.endswith(";base64"):
                raise ValueError("Claude 图片 data URL 必须使用 base64 编码")
            source = {
                "type": "base64",
                "media_type": header[5:-7],
                "data": data,
            }
        else:
            source = {"type": "url", "url": reference}
        content.append({"type": "image", "source": source})
    return content
