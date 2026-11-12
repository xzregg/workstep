import asyncio
import io
import json
import sys
import tarfile
from pathlib import Path

import pytest


def test_curated_catalog_has_ten_models_with_pinned_gguf_manifests():
    from services.decision_catalog import MODELS
    assert len(MODELS)==10
    assert len({model['id'] for model in MODELS})==10
    native=[model for model in MODELS if model.get('backend')=='gguf']
    assert len(native)==7
    for model in native:
        assert model['runtime_kind']=='runtime-gguf'
        assert model['revision'] and model['min_memory_gib']>=4
        assert len(model['files'])==1
        name,size,digest=model['files'][0]
        assert name.endswith('.gguf') and 'mmproj' not in name
        assert size>0 and len(digest)==64


def test_native_archive_safely_materializes_internal_links_and_rejects_escape(tmp_path):
    from services.decision_native import unpack
    archive=tmp_path/'runtime.tar.gz'
    with tarfile.open(archive,'w:gz') as out:
        data=b'fake executable';info=tarfile.TarInfo('bin/llama-server');info.size=len(data);info.mode=0o755
        out.addfile(info,io.BytesIO(data))
        link=tarfile.TarInfo('bin/llama');link.type=tarfile.SYMTYPE;link.linkname='llama-server';out.addfile(link)
    target=tmp_path/'good';target.mkdir();unpack(archive,target)
    assert (target/'bin/llama').read_bytes()==b'fake executable'
    assert not (target/'bin/llama').is_symlink()
    with tarfile.open(archive,'w:gz') as out:
        info=tarfile.TarInfo('../escape');info.size=1;out.addfile(info,io.BytesIO(b'x'))
    with pytest.raises(ValueError):unpack(archive,tmp_path/'bad')


@pytest.mark.asyncio
async def test_native_runtime_private_auth_limits_reuse_release_and_response(tmp_path,monkeypatch):
    from services.decision_runtime import DecisionRuntime
    script=tmp_path/'server.py'
    script.write_text('''import os,json
from http.server import BaseHTTPRequestHandler,HTTPServer
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(b'{"status":"ok"}')
 def do_POST(self):
  if self.headers.get('Authorization')!='Bearer '+os.environ['LLAMA_API_KEY']:
   self.send_response(401);self.end_headers();return
  json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  self.send_response(200);self.end_headers();self.wfile.write(b'{"answers":{"ready":{"noul":0.9}}}')
server=HTTPServer(('127.0.0.1',0),Handler)
print('listening on http://127.0.0.1:'+str(server.server_port),flush=True)
server.serve_forever()
''')
    original=asyncio.create_subprocess_exec;commands=[]
    async def spawn(*args,**kwargs):
        commands.append(args)
        return await original(sys.executable,str(script),**kwargs)
    monkeypatch.setattr(asyncio,'create_subprocess_exec',spawn)
    (tmp_path/'llama-server').write_text('fixture')
    (tmp_path/'llama-server.exe').write_text('fixture')
    runtime=DecisionRuntime()
    model=tmp_path/'models/kev';model.mkdir(parents=True)
    try:
        for _ in range(2):
            result=await runtime.test_gguf(tmp_path,model,'weights.gguf',{'state':'ready','questions':{}})
            assert result['answers']['ready']['noul']==.9
        assert len(commands)==1
        args=commands[0]
        assert args[args.index('--port')+1]=='0'
        assert args[args.index('--host')+1]=='127.0.0.1'
        assert args[args.index('--threads')+1]=='1'
        assert args[args.index('--n-gpu-layers')+1]=='0'
        assert '--offline' in args
        process=runtime.process
        await runtime.close()
        assert process.returncode is not None and runtime.process is None
    finally:await runtime.close()


@pytest.mark.asyncio
async def test_native_component_download_is_verified_staged_and_independent(tmp_path,monkeypatch):
    import hashlib
    from services.decision_resources import DecisionResources
    from services import decision_native
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w:gz') as archive:
        for name in ('llama-server','llama-server.exe'):
            content=b'fixture executable';info=tarfile.TarInfo(name);info.size=len(content);info.mode=0o755
            archive.addfile(info,io.BytesIO(content))
    content=stream.getvalue();digest=hashlib.sha256(content).hexdigest()
    monkeypatch.setattr(decision_native,'asset',lambda:('native.tar.gz',len(content),digest))
    resource=DecisionResources(tmp_path);requested=[]
    async def fetch(client,url,path,size,expected,state):
        requested.append(url)
        assert size==len(content) and expected==digest
        path.write_bytes(content)
    async def check(command,timeout):
        assert Path(command[0]).is_file() and command[1]=='--version'
    monkeypatch.setattr(resource,'fetch',fetch);monkeypatch.setattr(resource,'run_process',check)
    await resource.download('runtime-gguf');await resource.task
    assert resource.installed('runtime-gguf')
    assert len(requested)==1 and requested[0].endswith('/native.tar.gz')
    assert not resource.installed('runtime') and not (tmp_path/'models').exists()
    assert not list(tmp_path.glob('.install-*'))


def test_native_model_environment_is_specific_to_size_and_component():
    from services.decision_environment import evaluate
    from services.decision_catalog import MODELS
    facts=dict(os='Linux',arch='x86_64',python=(3,12),bits=64,libc=('glibc','2.36'),
        mac_version='',installer=False,writable=True,cpus=4,memory_total=8*1024**3,
        memory_available=4*1024**3,disk_free=20*1024**3)
    small=next(model for model in MODELS if model['id']=='kev-0.8b-q8')
    large=next(model for model in MODELS if model['id']=='kev-9b-q4')
    assert evaluate(facts,installed=False,loaded=False,model=small)['supported']
    assert not evaluate(facts,installed=False,loaded=False,model=large)['supported']
    facts['libc']=('glibc','2.28')
    assert not evaluate(facts,installed=False,loaded=False,model=small)['supported']


def test_unreviewed_model_revision_or_backend_cannot_be_selected_or_discovered(monkeypatch):
    from services import decision_catalog as catalog
    from services.decision_discovery import search_models
    original=catalog.MODELS[0]
    for change in ({'id':'unreviewed'}, {'revision':'unreviewed'}, {'backend':'unknown'}):
        candidate={**original,**change}
        monkeypatch.setattr(catalog,'MODELS',[candidate])
        assert catalog.public_catalog()==[]
        with pytest.raises(ValueError):catalog.model_entry(candidate['id'])
        with pytest.raises(ValueError):catalog.resource_entry(candidate['resource_kind'])
        assert search_models('')['models']==[]
