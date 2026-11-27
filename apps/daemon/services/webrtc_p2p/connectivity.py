"""Bounded single-host UDP/STUN preflight; this does not verify a peer path."""

from __future__ import annotations

import asyncio

from aioice import stun

from .peer import parse_stun_servers


async def probe_stun(stun_urls: list[str], *, timeout: float = 3.0) -> bool:
    loop = asyncio.get_running_loop()

    async def probe(server: tuple[str, int]) -> bool:
        request = stun.Message(stun.Method.BINDING, stun.Class.REQUEST)
        reply = loop.create_future()
        transport = None

        class Protocol(asyncio.DatagramProtocol):
            def datagram_received(self, data, _addr):
                try:
                    response = stun.parse_message(data)
                except ValueError:
                    return
                if (not reply.done() and response.transaction_id == request.transaction_id
                        and response.message_method == stun.Method.BINDING
                        and response.message_class == stun.Class.RESPONSE
                        and "XOR-MAPPED-ADDRESS" in response.attributes):
                    reply.set_result(True)

        try:
            transport, _ = await loop.create_datagram_endpoint(Protocol, remote_addr=server)
            for delay in (0.2, 0.5, 1.0):
                transport.sendto(bytes(request))
                try:
                    return await asyncio.wait_for(asyncio.shield(reply), timeout=delay)
                except asyncio.TimeoutError:
                    pass
            return await reply
        except OSError:
            return False
        finally:
            if transport is not None:
                transport.close()

    tasks = [asyncio.create_task(probe(server)) for server in parse_stun_servers(stun_urls)]
    try:
        async with asyncio.timeout(timeout):
            for completed in asyncio.as_completed(tasks):
                if await completed:
                    return True
    except asyncio.TimeoutError:
        pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return False
