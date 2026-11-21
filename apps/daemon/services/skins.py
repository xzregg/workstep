"""Declarative skin packages. All filesystem work is isolated from the event loop."""
import asyncio
import hashlib
import io
import json
import re
import shutil
import threading
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from services.skin_extensions import CONFIG_KEYS, FILE_TYPES, compile_css, validate_extensions

CONTRACT_FILE = Path(__file__).resolve().parent.parent / "data" / "skins" / "contract.json"
BUNDLED_SKINS = {"interstellar-night": CONTRACT_FILE.parent / "bundled" / "interstellar-night"}
MAX_FILE = 8 * 1024 * 1024
MAX_PACKAGE = 32 * 1024 * 1024
MAX_FILES = 256
_ID = re.compile(r"[a-z][a-z0-9_-]{0,63}")
_BAD_CSS = re.compile(r"[;{}<>@!\\\x00-\x1f]|url\s*\(|expression\s*\(|(?:https?|data|javascript):", re.I)


def read_contract():
    return json.loads(CONTRACT_FILE.read_text(encoding="utf-8"))


def checked_id(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError("Invalid skin ID")
    return value


def css_value(value, kind="value", patterns=None):
    if not isinstance(value, str) or not value or len(value) > 512 or _BAD_CSS.search(value):
        raise ValueError("Invalid style value or contains disallowed content")
    if patterns and kind in patterns and not re.fullmatch(patterns[kind], value):
        raise ValueError("Style value does not match the attribute type")
    if kind == "asset":
        path = PurePosixPath(value)
        if not value.startswith("assets/") or ".." in path.parts or path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"} or not re.fullmatch(r"assets/[A-Za-z0-9_./-]+", value):
            raise ValueError("Background image must reference a local image within the assets")
    elif kind == "length":
        if not re.fullmatch(r"(?:0|(?:\d+(?:\.\d+)?)(?:px|rem|em|%)|var\(--[a-z][a-z0-9-]*\))(?: (?:0|\d+(?:\.\d+)?(?:px|rem|em|%))){0,3}", value):
            raise ValueError("Size must use a non-negative value or style variable")
        if any(float(n) > 256 for n in re.findall(r"(\d+(?:\.\d+)?)px", value)):
            raise ValueError("Component size out of range")
    elif kind == "weight" and not re.fullmatch(r"normal|bold|[1-9]00", value):
        raise ValueError("Invalid font weight")
    elif kind == "background-repeat" and value not in {"repeat", "no-repeat", "repeat-x", "repeat-y"}:
        raise ValueError("Invalid background repeat mode")
    return value


def validate_document(manifest, tokens, components, contract):
    allowed = {"id", "name", "version", "schema_version", "color_scheme", "description"}
    if not isinstance(manifest, dict) or set(manifest) - allowed:
        raise ValueError("Invalid skin list field")
    checked_id(manifest.get("id"))
    if manifest["id"] == "default":
        raise ValueError("Default skin cannot be overridden")
    if manifest.get("schema_version") not in (1, 2) or isinstance(manifest.get("schema_version"), bool):
        raise ValueError("Unsupported skin specification version")
    for key in ("name", "version"):
        if not isinstance(manifest.get(key), str) or not manifest[key].strip() or len(manifest[key]) > 100:
            raise ValueError(f"Invalid skin {key}")
    if manifest.get("color_scheme", "light") not in ("light", "dark"):
        raise ValueError("Invalid dark mode")
    if "description" in manifest and (not isinstance(manifest["description"], str) or len(manifest["description"]) > 1000):
        raise ValueError("Invalid skin description")
    if not isinstance(components, dict) or set(components) - {"styles", "layout", "desktop", "mobile"}:
        raise ValueError("Invalid component configuration field")
    def check_tokens(values):
        if not isinstance(values, dict) or set(values) - contract["tokens"].keys():
            raise ValueError("Unknown or protected style variable")
        for key, value in values.items():
            css_value(value, contract["token_kinds"][key], contract["value_patterns"])
    def check_styles(values):
        if not isinstance(values, dict) or set(values) - contract["parts"].keys():
            raise ValueError("Unknown component part")
        for part, states in values.items():
            if not isinstance(states, dict) or set(states) - contract["states"].keys():
                raise ValueError("Unknown component status")
            for properties in states.values():
                if not isinstance(properties, dict) or set(properties) - contract["properties"].keys():
                    raise ValueError("Unknown or protected style attribute")
                for key, value in properties.items():
                    if ("handle" in part or "resize" in part) and key in {"padding", "paddingInline", "paddingBlock", "borderWidth"}:
                        raise ValueError("The size of the dragged part is controlled by the layout configuration")
                    css_value(value, contract["properties"][key], contract["value_patterns"])
    check_tokens(tokens)
    check_styles(components.get("styles", {}))
    def check_layout(layout):
        if not isinstance(layout, dict) or set(layout) - contract["layout"].keys():
            raise ValueError("Unknown layout configuration")
        for key, value in layout.items():
            spec = contract["layout"][key]
            if key == "composerSendIcon" and isinstance(value, dict):
                paths = value.get("paths")
                if set(value) != {"paths"} or not isinstance(paths, list) or not 1 <= len(paths) <= 32 or any(not isinstance(path, str) or len(path) > 4096 or not re.match(r"^[Mm]\s*[-+.0-9]", path) or not re.fullmatch(r"[MmLlHhVvCcSsQqTtAaZz0-9., +\-]+", path) for path in paths):
                    raise ValueError("Invalid icon path")
                continue
            if "values" in spec:
                if value not in spec["values"]:
                    raise ValueError("Invalid layout options")
            elif isinstance(value, bool) or not isinstance(value, (int, float)) or not spec["min"] <= value <= spec["max"]:
                raise ValueError("Layout dimensions out of range")
    check_layout(components.get("layout", {}))
    for mode in ("desktop", "mobile"):
        variant = components.get(mode, {})
        if not isinstance(variant, dict) or set(variant) - {"tokens", "styles", "layout"}:
            raise ValueError("Invalid terminal coverage configuration")
        check_tokens(variant.get("tokens", {}))
        check_styles(variant.get("styles", {}))
        check_layout(variant.get("layout", {}))
    overridden = set(components.get("styles", {}))
    for mode in ("desktop", "mobile"):
        overridden.update(components.get(mode, {}).get("styles", {}))
    return {"overridden": sorted(overridden), "inherited": sorted(set(contract["parts"]) - overridden)}


class SkinConflict(ValueError):
    """An explicit replacement decision is required."""


class SkinManager:
    def __init__(self, root=None):
        self._root = Path(root) if root else None
        self._lock = threading.RLock()

    @property
    def root(self):
        from services.config import CONFIG_DIR
        return self._root or CONFIG_DIR / "runtime"

    def _read_package(self, path):
        root = Path(path).expanduser()
        if root.is_absolute() and not root.exists():
            raise FileNotFoundError(root)
        if not root.is_absolute() or root.is_symlink() or not root.is_dir():
            raise ValueError("The skin package must be an absolute path to a regular directory")
        files = {}
        size = 0
        for file in root.rglob("*"):
            if file.is_symlink():
                raise ValueError("Skin package cannot contain symbolic links")
            if file.is_dir():
                if file.relative_to(root).parts[0] != "assets":
                    raise ValueError("Only the assets subdirectory is allowed")
                continue
            name = file.relative_to(root).as_posix()
            if not file.is_file() or (name not in {"skin.json", "tokens.json", "components.json", "theme.css", "theme.js"} and not name.startswith("assets/")):
                raise ValueError("The skin package contains unallowed files")
            if name.startswith("assets/"):
                if file.suffix.lower() == '.woff2':
                    if not re.fullmatch(r'assets/[A-Za-z0-9_./-]+', name) or '..' in PurePosixPath(name).parts:
                        raise ValueError('Invalid font path')
                else:
                    css_value(name, "asset")
            if file.stat().st_size > MAX_FILE:
                raise ValueError("Skin file is too large")
            data = file.read_bytes()
            size += len(data)
            if len(data) > MAX_FILE or size > MAX_PACKAGE or len(files) >= MAX_FILES:
                raise ValueError("Skin package is too large")
            if name.startswith("assets/"):
                valid = (name.lower().endswith(".png") and data.startswith(b"\x89PNG\r\n\x1a\n")) or (name.lower().endswith((".jpg", ".jpeg")) and data.startswith(b"\xff\xd8\xff")) or (name.lower().endswith(".webp") and data[:4] == b"RIFF" and data[8:12] == b"WEBP") or (name.lower().endswith('.woff2') and data.startswith(b'wOF2'))
                if not valid:
                    raise ValueError("Image content does not match the type")
            files[name] = data
        try:
            manifest = json.loads(files["skin.json"])
            tokens = json.loads(files.get("tokens.json", b"{}"))
            components = json.loads(files.get("components.json", b"{}"))
        except (KeyError, ValueError, UnicodeError) as exc:
            raise ValueError("Invalid or missing skin.json") from exc
        if not isinstance(manifest, dict):
            raise ValueError('The skin list must be a JSON object')
        extension = {}
        if manifest.get('schema_version') == 2:
            extension = {key: manifest[key] for key in CONFIG_KEYS if key in manifest}
            manifest = {key: value for key, value in manifest.items() if key not in CONFIG_KEYS}
            if 'tokens.json' in files or 'components.json' in files:
                raise ValueError('v2 configuration is uniformly written to skin.json')
            tokens = extension.get('tokens', {})
            components = {key: extension[key] for key in ('styles', 'layout', 'desktop', 'mobile') if key in extension}
            validate_extensions(extension)
        elif any(name in files for name in ('theme.css', 'theme.js')) or any(name.endswith('.woff2') for name in files):
            raise ValueError('Freeform style and components require v2 skin')
        contract = read_contract()
        coverage = validate_document(manifest, tokens, components, contract)
        for styles in [components.get("styles", {}), *[components.get(mode, {}).get("styles", {}) for mode in ("desktop", "mobile")]]:
            for states in styles.values():
                for props in states.values():
                    if "backgroundImage" in props and props["backgroundImage"] not in files:
                        raise ValueError("Background image does not exist")
        digest = hashlib.sha256()
        for name, content in sorted(files.items()):
            digest.update(name.encode()); digest.update(b"\0"); digest.update(content); digest.update(b"\0")
        revision = digest.hexdigest()
        skin = {"manifest": {"color_scheme": "light", **manifest}, "tokens": tokens,
                "styles": components.get("styles", {}), "layout": components.get("layout", {}),
                "desktop": components.get("desktop", {}), "mobile": components.get("mobile", {}),
                "revision": revision, "asset_base": f"/api/skins/assets/{revision}"}
        if manifest['schema_version'] == 2:
            try:
                source = files.get('theme.css', b'').decode('utf-8')
                files.get('theme.js', b'').decode('utf-8')
            except UnicodeError as exc:
                raise ValueError('CSS and JavaScript must be UTF-8') from exc
            skin.update(css=compile_css(source, manifest['id'], revision, files),
                        script='theme.js' if 'theme.js' in files else '',
                        file_base=f'/api/skins/files/{revision}',
                        menus=extension.get('menus', []), effects=extension.get('effects', {}))
        return skin, coverage, files

    def _snapshot(self, revision, files):
        target = self.root / "skin-assets" / revision
        if target.exists():
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        staging = target.parent / ("." + uuid.uuid4().hex)
        try:
            staging.mkdir()
            for name, content in files.items():
                file = staging / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(content)
            staging.rename(target)
        finally:
            if staging.exists(): shutil.rmtree(staging)

    def _validate(self, path):
        with self._lock:
            skin, coverage, files = self._read_package(path)
            self._snapshot(skin["revision"], files)
            return {"ok": True, "skin": skin, "coverage": coverage,
                    "checks": ["schema", "properties", "layout", "assets"], "visual_checked": False}

    async def validate(self, path):
        return await asyncio.to_thread(self._validate, path)

    def _save_draft(self, path, expected_revision, document):
        with self._lock:
            root = Path(path).expanduser()
            if root.resolve().is_relative_to((self.root / 'skin-assets').resolve()):
                raise ValueError('Registered snapshots cannot be modified; please create a draft in the working directory')
            if not expected_revision:
                return self._create_draft(root, document)
            current, _, files = self._read_package(path)
            if current['revision'] != expected_revision:
                raise SkinConflict('The draft has been modified by the conversation. Please reload before saving adjustments.')
            manifest = document.get('manifest')
            if not isinstance(manifest, dict) or manifest.get('id') != current['manifest']['id']:
                raise ValueError('Fine-tuning cannot change the skin ID')
            tokens = document.get('tokens', {})
            components = {key: document[key] for key in ('styles', 'layout', 'desktop', 'mobile') if key in document}
            validate_document(manifest, tokens, components, read_contract())
            if manifest.get('schema_version') == 2:
                validate_extensions(document)
                changes = [('skin.json', {**manifest, **{key: document[key] for key in CONFIG_KEYS if key in document}})]
            else:
                changes = [('skin.json', manifest), ('tokens.json', tokens), ('components.json', components)]
            for name, value in changes:
                files[name] = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
            # Validate the entire candidate, including referenced assets, before touching the draft.
            staging = root.parent / ('.skin-edit-' + uuid.uuid4().hex)
            try:
                staging.mkdir()
                for name, content in files.items():
                    target = staging / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(content)
                self._read_package(staging)
                # Writers stage in the same filesystem; each JSON replacement is atomic.
                if self._read_package(root)[0]['revision'] != expected_revision:
                    raise SkinConflict('Draft has been modified, please reload')
                for name, _ in changes:
                    (staging / name).replace(root / name)
                return self._validate(root)
            finally:
                if staging.exists(): shutil.rmtree(staging)

    def _create_draft(self, root, document):
        from services.customization_workspace import workspace_root
        workspace = workspace_root().resolve()
        if not root.is_absolute() or root.is_symlink() or root.resolve() == workspace or not root.resolve().is_relative_to(workspace):
            raise ValueError('New skin package must be created in the Runtime workspace')
        if root.exists():
            raise SkinConflict('The conversation has already created this directory. Please reload it before saving.')
        manifest = document.get('manifest', {})
        tokens = document.get('tokens', {})
        components = {key: document[key] for key in ('styles', 'layout', 'desktop', 'mobile') if key in document}
        validate_document(manifest, tokens, components, read_contract())
        staging = workspace / ('.skin-edit-' + uuid.uuid4().hex)
        try:
            staging.mkdir()
            source_revision = document.get('revision', '')
            if isinstance(source_revision, str) and re.fullmatch(r'[a-f0-9]{64}', source_revision):
                source = self.root / 'skin-assets' / source_revision
                if source.exists():
                    original, _, files = self._read_package(source)
                    if original['revision'] != source_revision:
                        raise ValueError('Original skin resource validation mismatch')
                    for name, content in files.items():
                        if name.startswith('assets/') or (manifest.get('schema_version') == 2 and name in ('theme.css', 'theme.js')):
                            target = staging / name
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(content)
            changes = [('skin.json', {**manifest, **{key: document[key] for key in CONFIG_KEYS if key in document}})] if manifest.get('schema_version') == 2 else [('skin.json', manifest), ('tokens.json', tokens), ('components.json', components)]
            for name, value in changes:
                (staging / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            self._read_package(staging)
            try:
                root.mkdir()  # exclusive: never overwrite an AI-created package
            except FileExistsError as exc:
                raise SkinConflict('The conversation has already created this directory. Please re-read.') from exc
            for item in staging.iterdir():
                item.replace(root / item.name)
            return self._validate(root)
        finally:
            if staging.exists(): shutil.rmtree(staging)

    async def save_draft(self, path, expected_revision, document):
        return await asyncio.to_thread(self._save_draft, path, expected_revision, document)

    def _ensure_defaults(self):
        """Seed editable runtime packages once; existing edits and removals win."""
        with self._lock:
            packages = self.root / 'skin-packages'
            for skin_id, bundled in BUNDLED_SKINS.items():
                target = packages / skin_id
                if target.exists():
                    continue
                pointer = self.root / 'skins' / skin_id
                # Keep a previously installed package, including user modifications.
                source = self.root / 'skin-assets' / self._get(skin_id)['revision'] if pointer.exists() else bundled
                skin, _, files = self._read_package(source)
                if skin['manifest']['id'] != skin_id:
                    raise ValueError('Package skin ID does not match directory')
                packages.mkdir(parents=True, exist_ok=True)
                staging = packages / ('.skin-seed-' + uuid.uuid4().hex)
                try:
                    staging.mkdir()
                    for name, content in files.items():
                        file = staging / name
                        file.parent.mkdir(parents=True, exist_ok=True)
                        file.write_bytes(content)
                    if not pointer.exists():
                        self._register(staging)
                    staging.rename(target)
                finally:
                    if staging.exists(): shutil.rmtree(staging)

    async def ensure_defaults(self):
        await asyncio.to_thread(self._ensure_defaults)

    def _register(self, path, replace=False):
        with self._lock:
            skin, coverage, files = self._read_package(path)
            catalog = self.root / "skins"; catalog.mkdir(parents=True, exist_ok=True)
            target = catalog / skin["manifest"]["id"]
            if target.exists() and not replace:
                raise SkinConflict("Skin already exists; update requires explicit 'replace'")
            self._snapshot(skin["revision"], files)
            # Atomic pointer: readers only see an entire immutable snapshot.
            staged = catalog / ("." + uuid.uuid4().hex)
            try:
                staged.write_text(json.dumps({"revision": skin["revision"]}), encoding="utf-8")
                staged.replace(target)
            finally:
                staged.unlink(missing_ok=True)
            return {**skin, "coverage": coverage}

    async def register(self, path, *, replace=False):
        return await asyncio.to_thread(self._register, path, replace)

    def _get(self, skin_id):
        checked_id(skin_id)
        if skin_id == "default":
            return {"manifest": {"id": "default", "name": "默认皮肤", "version": "1", "schema_version": 1, "color_scheme": "light"}, "tokens": {}, "styles": {}, "layout": {}, "revision": "default", "asset_base": ""}
        pointer = json.loads((self.root / "skins" / skin_id).read_text(encoding="utf-8"))
        revision = pointer.get("revision", "")
        if not re.fullmatch(r"[a-f0-9]{64}", revision): raise ValueError("Skin index corrupted")
        skin, coverage, _ = self._read_package(self.root / "skin-assets" / revision)
        if skin["revision"] != revision: raise ValueError("Skin package verification mismatch")
        return {**skin, "coverage": coverage}

    async def get(self, skin_id):
        return await asyncio.to_thread(self._get, skin_id)

    def _list(self):
        with self._lock:
            result = [self._get("default")]
            catalog = self.root / "skins"
            if catalog.exists():
                for file in sorted(catalog.iterdir()):
                    if not _ID.fullmatch(file.name): continue
                    try: result.append(self._get(file.name))
                    except (ValueError, OSError): continue
            return [{"manifest": s["manifest"], "revision": s["revision"]} for s in result]

    async def list(self):
        return await asyncio.to_thread(self._list)

    def _delete(self, skin_id):
        checked_id(skin_id)
        if skin_id == "default": raise ValueError("Default skin cannot be deleted")
        with self._lock:
            (self.root / "skins" / skin_id).unlink()
        return {"ok": True}

    async def delete(self, skin_id):
        return await asyncio.to_thread(self._delete, skin_id)

    def _export(self, skin_id):
        with self._lock:
            skin = self._get(skin_id)
            if skin_id == "default": raise ValueError("Default skin cannot be exported")
            _, _, files = self._read_package(self.root / "skin-assets" / skin["revision"])
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
                for name, data in sorted(files.items()): archive.writestr(name, data)
            return output.getvalue()

    async def export(self, skin_id):
        return await asyncio.to_thread(self._export, skin_id)

    def _import_zip(self, data, replace=False):
        if len(data) > MAX_PACKAGE: raise ValueError("Skin ZIP is too large")
        self.root.mkdir(parents=True, exist_ok=True)
        draft = self.root / (".skin-import-" + uuid.uuid4().hex)
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                infos = archive.infolist(); total = 0; seen = set()
                if len(infos) > MAX_FILES: raise ValueError("Too many skin files")
                draft.mkdir()
                for info in infos:
                    name = info.filename; path = PurePosixPath(name)
                    total += info.file_size
                    if (path.is_absolute() or ".." in path.parts or "\\" in name or name in seen or info.file_size > MAX_FILE or total > MAX_PACKAGE or (info.external_attr >> 16) & 0o170000 == 0o120000):
                        raise ValueError("Invalid skin ZIP path or size")
                    seen.add(name)
                    file = draft / name
                    if info.is_dir(): file.mkdir(parents=True, exist_ok=True); continue
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_bytes(archive.read(info))
            return self._register(draft, replace)
        except zipfile.BadZipFile as exc:
            raise ValueError("Invalid ZIP file") from exc
        finally:
            if draft.exists(): shutil.rmtree(draft)

    async def import_zip(self, data, *, replace=False):
        return await asyncio.to_thread(self._import_zip, data, replace)

    def _asset(self, revision, name):
        if not re.fullmatch(r"[a-f0-9]{64}", revision): raise ValueError("Invalid resource version")
        css_value("assets/" + name, "asset")
        file = self.root / "skin-assets" / revision / "assets" / name
        if file.is_symlink() or not file.resolve().is_relative_to((self.root / "skin-assets" / revision).resolve()):
            raise ValueError("Invalid resource path")
        return file.read_bytes()

    async def asset(self, revision, name):
        return await asyncio.to_thread(self._asset, revision, name)

    def _file(self, revision, name):
        if not re.fullmatch(r'[a-f0-9]{64}', revision) or not re.fullmatch(r'[A-Za-z0-9_./-]+', name) or any(part in ('.', '..') for part in name.split('/')):
            raise ValueError('Invalid skin file path')
        if name not in ('theme.css', 'theme.js') and not name.startswith('assets/'):
            raise ValueError('Skin file is not readable')
        suffix = PurePosixPath(name).suffix.lower()
        if suffix not in FILE_TYPES or (name.startswith('assets/') and suffix in ('.css', '.js')):
            raise ValueError('Invalid skin file type')
        root = self.root / 'skin-assets' / revision
        file = root / name
        if file.is_symlink() or not file.resolve().is_relative_to(root.resolve()):
            raise ValueError('Invalid skin file path')
        return file.read_bytes(), FILE_TYPES[suffix]

    async def file(self, revision, name):
        return await asyncio.to_thread(self._file, revision, name)


skin_manager = SkinManager()
