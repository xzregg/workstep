"""Read the JSON payload inside an application-owned XML prompt section."""

import json
import re


def read_context(prompt, name="context"):
    match = re.search(rf"(?ms)^<{name}>\n(.*?)^</{name}>\n?", prompt)
    assert match, f"Missing <{name}> prompt section"
    description, separator, payload = match.group(1).partition('\n\n')
    assert description.strip() and separator, f"Missing purpose for <{name}> JSON"
    return json.loads(payload)
