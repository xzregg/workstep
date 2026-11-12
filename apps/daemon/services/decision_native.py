"""Pinned native CPU runtime assets and safe archive materialization."""
import json
import os
import platform
import posixpath
import shutil
import stat
import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

VERSION='b12110'
BASE=f'https://github.com/ggml-org/llama.cpp/releases/download/{VERSION}'
ASSETS={
 ('darwin','arm64'):('llama-b12110-bin-macos-arm64.tar.gz',16650691,'4f5b8de12e0b9516658ca6a5764c6ffb3d7c659c3dd538556b1413c7b4050662'),
 ('linux','x86_64'):('llama-b12110-bin-ubuntu-x64.tar.gz',23051958,'368227edcc229be5f9bed16a2223d79b5e41d0ac2e19bcf5825e82291c060e55'),
 ('linux','arm64'):('llama-b12110-bin-ubuntu-arm64.tar.gz',18723578,'4758b51335e37b4346251f2687d64841ff1c07ecb27fc46323945bb2ec9c44d2'),
 ('win32','x86_64'):('llama-b12110-bin-win-cpu-x64.zip',24708445,'98901e327c252875accaf2d1bf364e10e868843b0b63468baad1aa945cdc5da2'),
}

def asset():
    arch=platform.machine().lower()
    arch={'amd64':'x86_64','aarch64':'arm64'}.get(arch,arch)
    try:return ASSETS[(sys.platform,arch)]
    except KeyError:raise ValueError('当前平台没有匹配的原生 CPU 推理组件') from None


def _safe(name):
    path=PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name:
        raise ValueError('运行组件压缩包包含非法路径')
    return path


def unpack(archive,target):
    target=Path(target)
    count=0;total=0
    def copy(name,size,source,executable=False):
        nonlocal count,total
        path=_safe(name);count+=1;total+=size
        if count>2000 or total>1024**3:raise ValueError('运行组件解压体积超限')
        dest=target.joinpath(*path.parts);dest.parent.mkdir(parents=True,exist_ok=True)
        with dest.open('wb') as output:shutil.copyfileobj(source,output,256*1024)
        if executable:dest.chmod(0o755)
    if str(archive).endswith('.zip'):
        with zipfile.ZipFile(archive) as source:
            for item in source.infolist():
                _safe(item.filename)
                if item.is_dir():continue
                if stat.S_ISLNK(item.external_attr>>16):raise ValueError('不支持 ZIP 符号链接')
                with source.open(item) as data:copy(item.filename,item.file_size,data)
    else:
        with tarfile.open(archive,'r:gz') as source:
            members=source.getmembers();index={posixpath.normpath(m.name):m for m in members}
            for item in members:
                _safe(item.name)
                if item.isdir():continue
                resolved=item
                for _ in range(8):
                    if resolved.isfile():break
                    if not (resolved.issym() or resolved.islnk()):raise ValueError('不支持的压缩包成员')
                    link=posixpath.normpath(posixpath.join(posixpath.dirname(resolved.name),resolved.linkname) if resolved.issym() else resolved.linkname)
                    _safe(link);resolved=index.get(link)
                    if resolved is None:raise ValueError('运行组件链接无效')
                if not resolved.isfile():raise ValueError('运行组件链接循环')
                with source.extractfile(resolved) as data:copy(item.name,resolved.size,data,bool(resolved.mode&0o111))


def find_binary(root):
    name='llama-server.exe' if sys.platform=='win32' else 'llama-server'
    matches=list(Path(root).rglob(name))
    if len(matches)!=1 or matches[0].is_symlink():raise ValueError('未找到唯一的原生推理程序')
    return matches[0]


def marker(root):
    return {'version':VERSION,'platform':[sys.platform,platform.machine()],
            'asset':asset()[0],'binary':str(find_binary(root).relative_to(root))}


def installed(root):
    try:
        data=json.loads((root/'installed.json').read_text())
        binary=root/data['binary']
        return (data['version']==VERSION and data['asset']==asset()[0]
                and data['platform']==[sys.platform,platform.machine()]
                and not binary.is_symlink() and binary.is_file()
                and binary.resolve().is_relative_to(root.resolve()))
    except (OSError,ValueError,KeyError):return False
