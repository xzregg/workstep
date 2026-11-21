"""Validated, immutable Runtime language packs; all disk work is off-loop."""
import asyncio
import hashlib
import io
import json
import re
import tempfile
import threading
import zipfile
from collections import Counter
from pathlib import Path

from services.skins import checked_id

MAX_PACKAGE = 8 * 1024 * 1024
BUILTINS = {'zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'fr-FR', 'de-DE', 'ar'}
FILES = {'manifest.json', 'messages.json', 'glossary.json'}

class LanguageConflict(ValueError):
    pass

def read_contract():
    return json.loads((Path(__file__).parent.parent / 'data/languages/catalog.json').read_text(encoding='utf-8'))

def pairs(items):
    result = {}
    for key, value in items:
        if key in result or key in {'__proto__', 'constructor', 'prototype'}:
            raise ValueError('JSON contains duplicate or invalid keys')
        result[key] = value
    return result

def decode(data):
    return json.loads(data, object_pairs_hook=pairs)

class LanguageManager:
    def __init__(self, root=None):
        self._root = root
        self._lock = threading.RLock()

    @property
    def root(self):
        from services.config import CONFIG_DIR
        return self._root or CONFIG_DIR / 'runtime'

    def _read_package(self, path):
        root = Path(path).expanduser()
        if not root.is_absolute(): raise ValueError('The language pack path must be an absolute path')
        if not root.is_dir(): raise FileNotFoundError(path)
        files = {}
        for entry in root.iterdir():
            if entry.name not in FILES or entry.is_symlink() or not entry.is_file():
                raise ValueError('Language packs only allow manifest.json, messages.json, and glossary.json')
            if entry.stat().st_size > MAX_PACKAGE // 2: raise ValueError('Language file is too large')
            files[entry.name] = entry.read_bytes()
        if sum(map(len, files.values())) > MAX_PACKAGE: raise ValueError('Language pack is too large')
        if not {'manifest.json', 'messages.json'} <= files.keys(): raise ValueError('Missing language pack file')
        manifest, messages = decode(files['manifest.json']), decode(files['messages.json'])
        allowed = {'schema_version', 'id', 'locale', 'name', 'native_name', 'version', 'fallback_locale', 'direction', 'catalog_revision'}
        if not isinstance(manifest, dict) or set(manifest) != allowed: raise ValueError('The language manifest field is incomplete or unknown')
        if type(manifest['schema_version']) is not int or manifest['schema_version'] != 1 or manifest['direction'] != 'ltr': raise ValueError('Currently, only schema_version=1 and ltr are supported')
        for key in allowed - {'schema_version'}:
            if not isinstance(manifest[key], str) or not manifest[key].strip() or len(manifest[key]) > 160: raise ValueError('Invalid language manifest field')
        checked_id(manifest['id'])
        if not re.fullmatch('[a-f0-9]{64}', manifest['catalog_revision']): raise ValueError('Invalid copywriting catalog version')
        if not re.fullmatch(r'[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*', manifest['locale']): raise ValueError('locale must be a BCP47 language identifier')
        if manifest['locale'].lower() in {x.lower() for x in BUILTINS} or manifest['fallback_locale'] not in BUILTINS: raise ValueError('Built-in languages cannot be overwritten; fallback must select a built-in language')
        catalog = read_contract()
        if not isinstance(messages, dict) or not set(catalog['required_keys']) <= messages.keys(): raise ValueError('Missing required text for authorization, allowance, rejection, or confirmation')
        for key, text in messages.items():
            if key not in catalog['messages'] or not isinstance(text, str) or not text.strip() or len(text) > 20000: raise ValueError('Unknown key or empty text:' + key)
            if re.search(r'<[!/A-Za-z][^>]*>', text): raise ValueError('Language pack prohibits HTML:' + key)
            if Counter(re.findall(r'\{(\w+)\}', text)) != Counter(re.findall(r'\{(\w+)\}', catalog['messages'][key])): raise ValueError('Placeholder mismatch:' + key)
        if 'glossary.json' in files:
            glossary = decode(files['glossary.json'])
            if not isinstance(glossary, dict) or any(not isinstance(v, str) for v in glossary.values()): raise ValueError('The glossary must be a string dictionary')
        canonical = json.dumps({name: decode(data) for name, data in sorted(files.items())}, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        revision = hashlib.sha256(canonical).hexdigest()
        missing = sorted(set(catalog['messages']) - messages.keys())
        coverage = {'total': len(catalog['messages']), 'translated': len(messages), 'missing': missing}
        return {'manifest': manifest, 'messages': messages, 'revision': revision, 'coverage': coverage}, files

    def _validate(self, path):
        package, _ = self._read_package(path)
        return {'ok': True, 'package': package, 'coverage': package['coverage']}

    def _get(self, id):
        checked_id(id)
        revision = (self.root / 'language-packs' / id).read_text().strip()
        if not re.fullmatch('[a-f0-9]{64}', revision): raise ValueError('Invalid language pack index')
        document, _ = self._read_package(self.root / 'language-assets' / revision)
        if document['revision'] != revision or document['manifest']['id'] != id: raise ValueError('Language pack integrity check failed')
        return document

    def _list(self):
        catalog = self.root / 'language-packs'
        if not catalog.exists(): return []
        result = []
        for entry in sorted(catalog.iterdir()):
            if entry.name.startswith('.'): continue
            document = self._get(entry.name)
            result.append({key: document[key] for key in ('manifest', 'revision', 'coverage')})
        return result

    def _register(self, path, replace):
        with self._lock:
            document, files = self._read_package(path)
            id = document['manifest']['id']
            catalog = self.root / 'language-packs'
            catalog.mkdir(parents=True, exist_ok=True)
            pointer = catalog / id
            if pointer.exists() and not replace: raise LanguageConflict('Language pack already exists, please confirm replacement')
            snapshots = self.root / 'language-assets'
            snapshots.mkdir(parents=True, exist_ok=True)
            destination = snapshots / document['revision']
            if not destination.exists():
                with tempfile.TemporaryDirectory(dir=snapshots) as temporary:
                    staging = Path(temporary) / 'package'; staging.mkdir()
                    for name, data in files.items(): (staging / name).write_bytes(data)
                    staging.rename(destination)
            with tempfile.NamedTemporaryFile(dir=catalog, prefix='.language-', delete=False) as temporary:
                temporary.write(document['revision'].encode())
                pending = Path(temporary.name)
            try: pending.replace(pointer)
            finally: pending.unlink(missing_ok=True)
            return document

    def _delete(self, id):
        with self._lock:
            checked_id(id); (self.root / 'language-packs' / id).unlink()
            return {'ok': True}

    def _export(self, id):
        document = self._get(id)
        _, files = self._read_package(self.root / 'language-assets' / document['revision'])
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items(): archive.writestr(name, data)
        return output.getvalue()

    def _import(self, data, replace):
        if len(data) > MAX_PACKAGE: raise ValueError('Language pack is too large')
        with tempfile.TemporaryDirectory() as temporary:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                if len(entries) > 3 or len({e.filename for e in entries}) != len(entries): raise ValueError('Duplicate or excessive ZIP files')
                if any(e.filename not in FILES or e.file_size > MAX_PACKAGE // 2 or (e.external_attr >> 16) & 0o170000 == 0o120000 for e in entries): raise ValueError('Invalid ZIP path or file')
                if sum(e.file_size for e in entries) > MAX_PACKAGE: raise ValueError('Language pack is too large')
                for entry in entries: (Path(temporary) / entry.filename).write_bytes(archive.read(entry))
            return self._register(temporary, replace)

    async def validate(self, path): return await asyncio.to_thread(self._validate, path)
    async def register(self, path, replace=False): return await asyncio.to_thread(self._register, path, replace)
    async def get(self, id): return await asyncio.to_thread(self._get, id)
    async def list(self): return await asyncio.to_thread(self._list)
    async def delete(self, id): return await asyncio.to_thread(self._delete, id)
    async def export(self, id): return await asyncio.to_thread(self._export, id)
    async def import_zip(self, data, replace=False):
        try: return await asyncio.to_thread(self._import, data, replace)
        except zipfile.BadZipFile as exc: raise ValueError('Invalid ZIP') from exc

language_manager = LanguageManager()
