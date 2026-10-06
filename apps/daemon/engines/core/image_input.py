"""Image path fallback, explicitly selected by engine adapters."""

from engines.core.schema import EngineImage


def render_image_prompt(
    prompt: str,
    images: list[EngineImage] | None,
) -> str:
    """Append attached images as markdown references to a text prompt.

    Only adapters that use file references should call this helper. Native
    multimodal adapters pass images directly without changing the prompt.
    """
    if not images:
        return prompt
    lines = [prompt, "", "Attached image(s); analyze them if possible:"]
    for image in images:
        alt = image.description or "attached image"
        lines.append(f"![{alt}]({image.reference})")
    return "\n".join(lines)

