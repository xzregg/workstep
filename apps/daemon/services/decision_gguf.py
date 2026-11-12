"""Private, bounded localhost transport to one managed native decision worker."""
import asyncio
import json
import os
import re
import secrets

import httpx
from engines.core.stream_lines import ChunkedLineReader
from services.decision_native import find_binary


class NativeDecisionWorker:
    def __init__(self):
        self.process=None
        self.drain=None
        self.endpoint=None
        self.key=None
        self.ready=False

    async def start(self,runtime,model,filename):
        binary=await asyncio.to_thread(find_binary,runtime)
        self.endpoint=asyncio.get_running_loop().create_future()
        self.key=secrets.token_urlsafe(32);self.ready=False
        self.process=await asyncio.create_subprocess_exec(str(binary),
            '--model',str(model/filename),'--host','127.0.0.1','--port','0',
            '--threads','1','--threads-batch','1','--threads-http','1','--parallel','1',
            '--n-gpu-layers','0','--ctx-size','1024','--batch-size','1024','--ubatch-size','1024',
            '--cache-ram','0','--prio','-1','--offline','--no-webui',
            stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.STDOUT,
            env={**os.environ,'LLAMA_API_KEY':self.key,'OMP_NUM_THREADS':'1','MKL_NUM_THREADS':'1'})
        self.drain=asyncio.create_task(self._drain(),name='decision-native-output')
        return self.process

    async def _drain(self):
        reader=ChunkedLineReader(self.process.stdout,max_line_bytes=1024*1024)
        try:
            while line:=await reader.readline():
                # Read only the port the owned process actually bound; never reserve/release a guessed port.
                match=re.search(rb'listening on http://127\.0\.0\.1:(\d+)',line)
                if match and not self.endpoint.done():
                    port=int(match[1])
                    if 1<=port<=65535:self.endpoint.set_result(f'http://127.0.0.1:{port}')
        finally:
            if not self.endpoint.done():self.endpoint.set_result(None)

    async def infer(self,payload):
        async with asyncio.timeout(120 if not self.ready else 20):
            base=await asyncio.shield(self.endpoint)
            if not base:raise ValueError('原生推理启动失败')
            async with httpx.AsyncClient(base_url=base,trust_env=False,
                    headers={'Authorization':'Bearer '+self.key},timeout=15,follow_redirects=False) as client:
                while not self.ready:
                    if self.process.returncode is not None:raise ValueError('原生推理进程已退出')
                    try:
                        response=await client.get('/health')
                        self.ready=response.status_code==200
                    except httpx.ConnectError:pass
                    if not self.ready:await asyncio.sleep(.1)
                async with client.stream('POST','/v1/systemone',json=payload) as response:
                    response.raise_for_status();data=bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(data)+len(chunk)>1024*1024:raise ValueError('原生推理响应过大')
                        data.extend(chunk)
                    return await asyncio.to_thread(json.loads,data)

    async def close(self):
        process,self.process=self.process,None
        if process:
            if process.returncode is None:
                try:process.kill()
                except ProcessLookupError:pass
            await process.wait()
        if self.drain:
            self.drain.cancel()
            try:await self.drain
            except asyncio.CancelledError:pass
            self.drain=None
        self.endpoint=None;self.key=None;self.ready=False
