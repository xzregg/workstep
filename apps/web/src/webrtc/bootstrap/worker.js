/* Only controlled /p2p/<device>/ clients can route resources to their own peer. */
function directRoute(value, clientValue) {
  const client=new URL(clientValue),url=new URL(value);
  const match=client.pathname.match(/^\/p2p\/([A-Za-z0-9._-]{1,128})(?:\/|$)/);
  if(!match||url.origin!==client.origin)return null;
  const prefix='/p2p/'+match[1]+'/__host';
  let path=url.pathname;
  if(path.startsWith(prefix+'/'))path=path.slice(prefix.length);
  else if(path.startsWith('/p2p/')||path.startsWith('/p2p-bootstrap/')||path.startsWith('/api/webrtc/')||path.startsWith('/ws/webrtc/'))return null;
  return {device:match[1],path:path+url.search,key:new URL(prefix+path+url.search,url.origin).href};
}
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||!event.clientId)return;
  // Top-level navigation always loads the small gateway bootstrap again.
  if(event.request.mode==='navigate'&&!new URL(event.request.url).pathname.includes('/__host/'))return;
  event.respondWith((async()=>{
    let client=await self.clients.get(event.clientId);
    if(client&&client.type!=='window'){
      const device=new URL(client.url).pathname.match(/^\/p2p\/([^/]+)\//)?.[1];
      const windows=await self.clients.matchAll({type:'window'});
      client=windows.find(item=>new URL(item.url).pathname.startsWith('/p2p/'+device+'/'));
    }
    const route=client&&directRoute(event.request.url,client.url);
    if(!route)return fetch(event.request);
    const cacheable=/^\/assets\/.+[.-][A-Za-z0-9_-]{8,}\.[^/]+(?:\?|$)/.test(route.path);
    const cache=cacheable?await caches.open('workstep-direct-assets-v1-'+route.device).catch(()=>null):null;
    const cached=cache&&await cache.match(route.key).catch(()=>null);
    if(cached)return cached;
    const response=await new Promise(resolve=>{
      const channel=new MessageChannel();
      const timer=setTimeout(()=>{channel.port1.close();resolve(new Response('Direct resource timed out',{status:504}));},60000);
      channel.port1.onmessage=message=>{
        clearTimeout(timer);channel.port1.close();
        const value=message.data;
        resolve(new Response(value.body,{status:value.status,headers:value.headers}));
      };
      client.postMessage({type:'workstep:direct-resource',path:route.path},[channel.port2]);
    });
    if(cache&&response.ok){
      try{
        await cache.put(route.key,response.clone());
        const keys=await cache.keys();
        for(const key of keys.slice(0,Math.max(0,keys.length-128)))await cache.delete(key);
      }catch{/* Storage restrictions must not prevent direct loading. */}
    }
    return response;
  })());
});
