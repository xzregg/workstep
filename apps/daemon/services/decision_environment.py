"""Offline host capability probe for the pinned CPU inference runtime.

All callers run this module's filesystem/platform probes in an executor.
Thresholds are WorkStep admission policy, not upstream hardware requirements.
"""
import os
import platform
import shutil
import struct
import sys
from pathlib import Path

import psutil
from engines.core.base import _has_pip

GiB = 1024 ** 3


def container_limits(total, available, cpus, root=Path('/sys/fs/cgroup')):
    def number(path):
        try: return int((root / path).read_text().strip())
        except (OSError, ValueError): return None
    limit = number('memory.max') or number('memory/memory.limit_in_bytes')
    used = number('memory.current')
    if used is None: used = number('memory/memory.usage_in_bytes')
    if limit and limit > 0:
        total = min(total, limit)
        available = min(available, max(0, limit - (used or 0)))
    try:
        quota, period = (root / 'cpu.max').read_text().split()
        quota, period = int(quota), int(period)
    except (OSError, ValueError):
        quota, period = number('cpu/cpu.cfs_quota_us'), number('cpu/cpu.cfs_period_us')
    if quota and period and quota > 0 and period > 0:
        cpus = min(cpus, quota / period)
    return total, available, cpus


def read_facts(root):
    parent = Path(root)
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    memory = psutil.virtual_memory()
    cpus = os.cpu_count() or 1
    try: cpus = min(cpus, len(psutil.Process().cpu_affinity()))
    except (AttributeError, psutil.Error): pass
    total, available = memory.total, memory.available
    if sys.platform.startswith('linux'):
        total, available, cpus = container_limits(total, available, cpus)
    return dict(os=platform.system(), arch=platform.machine(), python=sys.version_info[:2],
        bits=struct.calcsize('P')*8, libc=platform.libc_ver(), mac_version=platform.mac_ver()[0],
        installer=bool(shutil.which('uv') or _has_pip()), writable=os.access(parent, os.W_OK),
        cpus=cpus, memory_total=total, memory_available=available,
        disk_free=shutil.disk_usage(parent).free)



def probe(root, *, installed=False, loaded=False, model=None, facts=None):
    return evaluate(facts if facts is not None else read_facts(root), installed=installed,
                    loaded=loaded, model=model)


def evaluate(facts, *, installed, loaded, model=None):
    model = model or {}
    native = model.get('backend') == 'gguf'
    minimum_memory = model.get('min_memory_gib', 4)
    minimum_available = model.get('min_available_gib', 2)
    reasons = []
    arch = facts['arch'].lower()
    system = facts['os']
    compatible = facts['bits'] == 64 and (
        (system == 'Windows' and arch in ('amd64','x86_64')) or
        (system == 'Darwin' and arch == 'arm64') or
        (system == 'Linux' and arch in ('amd64','x86_64','aarch64','arm64')))
    if not compatible: reasons.append('当前系统或 CPU 架构没有匹配的推理运行组件')
    if not (3,11) <= tuple(facts['python']) <= (3,14):
        reasons.append('推理运行组件要求 Python 3.11–3.14')
    def version(value):
        try: return tuple(int(p) for p in value.split('.')[:2])
        except ValueError: return (0,)
    if system == 'Darwin' and version(facts['mac_version']) < (14,0):
        reasons.append('当前运行组件要求 macOS 14 或更新版本')
    if system == 'Linux' and (facts['libc'][0] != 'glibc' or version(facts['libc'][1]) < ((2,35) if native else (2,28))):
        reasons.append('原生组件要求 glibc 2.35 或更新版本' if native else '当前运行组件要求 glibc 2.28 或更新版本，不支持 musl 镜像')
    if facts['cpus'] < 2: reasons.append('至少需要 2 个可用 CPU 核心，容器需分配不少于 2 核')
    if facts['memory_total'] < minimum_memory*GiB: reasons.append(f'该型号至少需要 {minimum_memory} GiB 总内存额度')
    if not loaded and facts['memory_available'] < minimum_available*GiB: reasons.append(f'该型号启动至少需要 {minimum_available} GiB 当前可用内存')
    download_space = max(3*GiB, sum(file[1] for file in model.get('files', []))*2 + 128*1024**2)
    if facts['disk_free'] < (128*1024**2 if installed else download_space):
        reasons.append(f'磁盘空间不足：下载时需预留 {download_space / GiB:.1f} GiB，安装后保留 128 MiB')
    if not facts['writable']: reasons.append('模型存储目录不可写')
    if not installed and not native and not facts['installer']: reasons.append('后台缺少可用的 pip 或 uv 安装器')
    return {'supported': not reasons, 'reasons': reasons, 'cpu_cores': facts['cpus'],
            'memory_total_bytes': facts['memory_total'], 'memory_available_bytes': facts['memory_available'],
            'disk_free_bytes': facts['disk_free']}
