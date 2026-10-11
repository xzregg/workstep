"""Register production CSS/JSX parts without duplicating the skin contract.

Run with --check in validation; use without flags when exposing new parts.
Existing selectors are stable v1 API and are retained when source code moves.
"""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "apps/daemon/data/skins/contract.json"


def parts():
    result = {}
    sources = list((ROOT / "apps/web/src").rglob("*.css")) + list((ROOT / "packages/gateway-ui/src").glob("*.css"))
    for file in sources:
        if "prototype" in str(file): continue
        text = re.sub(r"/\*.*?\*/", "", file.read_text(), flags=re.S)
        for selector in re.findall(r"([^{}]+)\{", text):
            for name in re.findall(r"\.([a-zA-Z_][\w-]*)", selector):
                if not name.startswith("skin-recovery"): result[name] = "." + name
            for name, pseudo in re.findall(r"\.([a-zA-Z_][\w-]*)(::(?:before|after|placeholder|marker|-webkit-scrollbar(?:-thumb|-track)?))", selector):
                if not name.startswith("skin-recovery"): result[name + pseudo] = "." + name + pseudo
    for file in (ROOT / "apps/web/src").rglob("*.tsx"):
        if "prototype" in str(file): continue
        for value in re.findall(r'className=["\']([^"\']+)["\']', file.read_text()):
            for name in value.split():
                if re.fullmatch(r"[a-zA-Z_][\w-]*", name) and not name.startswith("skin-recovery"):
                    result[name] = "." + name
    return result


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--check", action="store_true"); args = parser.parse_args()
    data = json.loads(CONTRACT.read_text())
    missing = {name: selector for name, selector in parts().items() if name not in data["parts"]}
    if args.check:
        if missing: raise SystemExit("Missing skin parts: " + ", ".join(sorted(missing)))
    else:
        data["parts"].update(missing); data["parts"] = dict(sorted(data["parts"].items()))
        CONTRACT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"Skin v{data['schema_version']}: {len(data['parts'])} registered parts")

if __name__ == "__main__": main()
