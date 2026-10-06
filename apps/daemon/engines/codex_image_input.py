"""Codex native turn inputs, kept separate from text prompt snapshots."""

from typing import Any

from engines.core.schema import EngineImage


def codex_wire_input(prompt: str, images: list[EngineImage] | None) -> str | list[dict]:
    """Raw app-server input for collaboration and goal turn-start seams."""
    if not images:
        return prompt
    items = [{"type": "text", "text": prompt}]
    for image in images:
        if image.path:
            items.append({"type": "localImage", "path": image.path})
        elif image.url:
            items.append({"type": "image", "url": image.url})
        else:
            raise ValueError("Codex 图片缺少路径或 URL")
    return items


def codex_sdk_input(prompt: str, images: list[EngineImage] | None) -> str | list[Any]:
    """Use the public SDK input types; local files are read by Codex itself."""
    if not images:
        return prompt
    from openai_codex import TextInput

    items = [TextInput(prompt)]
    for image in images:
        if image.path:
            from openai_codex import LocalImageInput

            items.append(LocalImageInput(image.path))
        elif image.url:
            from openai_codex import ImageInput

            items.append(ImageInput(image.url))
        else:
            raise ValueError("Codex 图片缺少路径或 URL")
    return items
