"""Recover workers of a dead daemon without matching process names.

The per-launch token is inherited by engines (including native SDK workers),
speech and decision models. Durable PID/create-time checkpoints also cover
children which clear their environment. A live daemon is never reclaimed.
"""
import asyncio
import json
import logging
import os
from pathlib import Path
import re
import uuid

import psutil

from engines.core.process_cleanup import _alive, _reap, finish_cleanup

logger = logging.getLogger(__name__)
OWNER_ENV = 'WORKSTEP_PROCESS_OWNER'
SCOPE_ENV = 'WORKSTEP_PROCESS_SCOPE'


def runtime_identity():
    """A persisted PID is meaningful only in its original kernel/namespace."""
    import hashlib
    import platform
    import socket
    realm = {'platform': platform.system(), 'boot_time': psutil.boot_time(),
             'host': socket.gethostname()}
    if realm['platform'] == 'Linux':
        # Refuse recovery when /proc identity is unavailable. Falling back to
        # PID/create-time alone can target another container after volume reuse.
        realm['boot_id'] = str(uuid.UUID(Path('/proc/sys/kernel/random/boot_id').read_text().strip()))
        for name in ('pid', 'cgroup'):
            stat = Path('/proc/self/ns', name).stat()
            realm[name + '_namespace'] = [stat.st_dev, stat.st_ino]
        # Namespace inode numbers themselves can be recycled when a container
        # is recreated. Its namespace's init process gives the lifetime too.
        realm['namespace_init_created'] = psutil.Process(1).create_time()
        realm['cgroup_membership'] = hashlib.sha256(Path('/proc/self/cgroup').read_bytes()).hexdigest()
    return realm


def identity(process):
    return {'pid': process.pid, 'created': process.create_time()}


def matching(record):
    try:
        pid = record['pid']
        if not isinstance(pid, int) or pid <= 0:
            return None
        process = psutil.Process(pid)
        if process.create_time() != record['created']:
            return None
        return process if _alive(process) else None
    except (psutil.NoSuchProcess, KeyError, TypeError):
        return None


class ProcessOwnership:
    def __init__(self, config_dir):
        self.directory = Path(config_dir) / 'runtime' / 'process-owners'
        self.scope = None
        self.token = uuid.uuid4().hex
        self.file = self.directory / (self.token + '.json')
        self.owner = None
        self.realm = None
        self.children = {}
        self.monitor = None
        self.previous_env = None
        self.existing = set()

    def write(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.file.with_suffix('.tmp')
        with temporary.open('w') as stream:
            json.dump({'version': 2, 'realm': self.realm, 'token': self.token, 'owner': self.owner,
                       'children': list(self.children.values())}, stream)
        temporary.replace(self.file)

    def checkpoint(self):
        protected = self.active_owners()
        for process in psutil.Process().children(recursive=True):
            try:
                data = identity(process)
                if self.protected(process, protected):
                    continue
                if (data['pid'], data['created']) in self.existing:
                    continue
                if any((p.pid, p.create_time()) in self.existing for p in process.parents()):
                    continue
                self.children[(data['pid'], data['created'])] = data
            except psutil.NoSuchProcess:
                pass
        # Drop exited or reused PIDs; no unbounded history for long-lived daemons.
        self.children = {key: value for key, value in self.children.items() if matching(value)}
        self.write()

    def active_owners(self):
        owners = set()
        for file in self.directory.glob('*.json'):
            try:
                if file.is_symlink() or file.stat().st_size > 8 * 1024 * 1024:
                    continue
                record = json.loads(file.read_text())
                if record.get('token') != file.stem:
                    continue
                if record.get('version') == 2 and record.get('realm') != self.realm:
                    continue
                if record.get('version') not in (1, 2):
                    continue
                process = matching(record['owner'])
                if process is not None and process.pid != os.getpid():
                    owners.add((process.pid, process.create_time()))
            except (OSError, ValueError, KeyError, TypeError, AttributeError, psutil.Error):
                pass
        return owners

    @staticmethod
    def protected(process, owners):
        if not owners:
            return False
        return any((p.pid, p.create_time()) in owners for p in [process, *process.parents()])

    def marked(self, token):
        processes = []
        for process in psutil.process_iter():
            try:
                if process.pid == os.getpid():
                    continue
                if hasattr(os, 'getuid') and process.uids().real != os.getuid():
                    continue
                env = process.environ()
                if env.get(OWNER_ENV) == token and env.get(SCOPE_ENV) == self.scope:
                    process.create_time()  # Cache psutil's PID-reuse identity.
                    processes.append(process)
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass
        return processes

    def reap(self, record):
        if record.get('version') != 2 or record.get('realm') != self.realm:
            return 0
        found = {}
        protected = self.active_owners()
        excluded = {os.getpid(), *(p.pid for p in psutil.Process().parents())}
        candidates = self.marked(record['token'])
        candidates += [p for item in record.get('children', []) if (p := matching(item))]
        for process in candidates:
            if process.pid in excluded:
                continue
            try:
                # Root and descendants have positive ownership from a token
                # or recorded PID/create-time, never just a familiar executable.
                for child in [*process.children(recursive=True), process]:
                    if child.pid not in excluded and not self.protected(child, protected):
                        data = identity(child)
                        found[(data['pid'], data['created'])] = child
            except psutil.NoSuchProcess:
                pass
        _reap(list(found.values()))
        return len(found)

    def recover(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        recovered = 0
        for file in self.directory.glob('*.json'):
            if file.is_symlink() or not re.fullmatch(r'[a-f0-9]{32}\.json', file.name):
                continue
            try:
                if file.stat().st_size > 8 * 1024 * 1024:
                    continue
                record = json.loads(file.read_text())
                if (record.get('version') != 2 or record.get('realm') != self.realm
                        or record.get('token') != file.stem):
                    continue
                if matching(record['owner']):
                    continue
                recovered += self.reap(record)
                file.unlink(missing_ok=True)
            except Exception:
                # Retain unreadable records for a later retry; do not guess.
                logger.warning('Could not recover a previous daemon worker record')
        return recovered

    async def start(self):
        await finish_cleanup(self._start())

    async def _start(self):
        try:
            await asyncio.to_thread(self.prepare)
        except Exception as exc:
            logger.warning('Worker ownership unavailable (%s); continuing startup', type(exc).__name__)
            return
        try:
            recovered = await asyncio.to_thread(self.recover)
            logger.info('Recovered %d workers from previous daemon instances', recovered)
        except Exception as exc:
            logger.warning('Previous worker recovery failed (%s); continuing startup', type(exc).__name__)
        try:
            await asyncio.to_thread(self.write)
        except Exception as exc:
            # Without a durable owner record, do not publish an untraceable
            # token or start the monitor. Service-specific cleanup still runs.
            logger.warning('Worker ownership persistence unavailable (%s); continuing startup', type(exc).__name__)
            return
        self.previous_env = {key: os.environ.get(key) for key in (OWNER_ENV, SCOPE_ENV)}
        os.environ.update({OWNER_ENV: self.token, SCOPE_ENV: self.scope})
        self.monitor = asyncio.create_task(self._monitor())

    def prepare(self):
        self.scope = str(self.directory.parent.parent.resolve())
        self.realm = runtime_identity()
        self.owner = identity(psutil.Process())
        for process in psutil.Process().children(recursive=True):
            try:
                if _alive(process):
                    data = identity(process)
                    self.existing.add((data['pid'], data['created']))
            except psutil.NoSuchProcess:
                pass

    async def _monitor(self):
        while True:
            await asyncio.sleep(1)
            try:
                await finish_cleanup(asyncio.to_thread(self.checkpoint))
            except Exception:
                logger.warning('Could not checkpoint owned workers')

    async def close(self):
        await finish_cleanup(self._close())

    async def _close(self):
        if self.monitor is not None:
            self.monitor.cancel()
            await asyncio.gather(self.monitor, return_exceptions=True)
            self.monitor = None
        if self.previous_env is None:
            return
        try:
            # Last safety net after normal service-specific shutdown. Also
            # removes workers which detached from their original process tree.
            complete = True
            try:
                await asyncio.to_thread(self.checkpoint)
            except Exception as exc:
                complete = False
                logger.warning('Final worker checkpoint failed (%s); retaining owner record', type(exc).__name__)
            try:
                await asyncio.to_thread(self.reap, {'version': 2, 'realm': self.realm,
                    'token': self.token, 'children': list(self.children.values())})
            except Exception as exc:
                complete = False
                logger.warning('Final worker cleanup failed (%s); retaining owner record', type(exc).__name__)
            if complete:
                try:
                    await asyncio.to_thread(self.file.unlink, missing_ok=True)
                except Exception as exc:
                    logger.warning('Could not remove worker owner record (%s)', type(exc).__name__)
        finally:
            if os.environ.get(OWNER_ENV) == self.token:
                for key, value in self.previous_env.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
            self.previous_env = None
