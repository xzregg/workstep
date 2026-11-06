export function activate(api) {
  const React = api.React;
  function GalaxyBackground() {
    const ref = React.useRef(null);
    React.useEffect(() => {
      const marker = ref.current;
      const host = marker.closest('[data-ui="workspace"], .app-shell, .skin-workspace-frame');
      if (!host) return;
      const canvas = document.createElement('canvas');
      canvas.className='stellar-flow-canvas';
      canvas.setAttribute('aria-hidden','true');
      host.prepend(canvas);
      const gl = canvas.getContext('webgl', {alpha:false, antialias:false, depth:false, stencil:false, powerPreference:'low-power'});
      if (!gl) { canvas.remove(); return; }
      let disposed=false, ready=false, timer=0, time=0, last=performance.now(), aspect=1;
      const shaders=[];
      let program, buffer, texture;
      const motion=matchMedia('(prefers-reduced-motion: reduce)');
      const image=new Image();
      const observer=new ResizeObserver(()=>draw());
      observer.observe(host);
      canvas.dataset.state='loading';
      function cleanup() {
        if(disposed) return;
        disposed=true; clearTimeout(timer); image.onload=null; image.onerror=null;
        canvas.removeAttribute('data-ready');
        observer.disconnect();
        canvas.remove();
        document.removeEventListener('visibilitychange', restart);
        motion.removeEventListener('change', restart);
        window.removeEventListener('resize', draw);
        api.signal.removeEventListener('abort',cleanup);
        canvas.removeEventListener('webglcontextlost',lost);
        if(texture) gl.deleteTexture(texture);
        if(buffer) gl.deleteBuffer(buffer);
        if(program) gl.deleteProgram(program);
        shaders.forEach(shader=>gl.deleteShader(shader));
      }
      function lost(event){event.preventDefault();cleanup();}
      function restart(){clearTimeout(timer);last=performance.now();if(!disposed&&!document.hidden)tick();}
      let clockLocation, ratioLocation;
      function draw(){
        if(!ready||disposed||gl.isContextLost())return;
        const rect=host.getBoundingClientRect();
        if(rect.width<=0||rect.height<=0)return;
        const mobile=rect.width<1024, cap=mobile?480:960;
        const w=Math.min(Math.round(rect.width),cap),h=Math.max(1,Math.round(rect.height*w/rect.width));
        if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
        gl.viewport(0,0,w,h);
        const a=w/h;
        gl.uniform2f(ratioLocation,a<aspect?a/aspect:1,a>aspect?aspect/a:1);
        gl.uniform1f(clockLocation,time);
        gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
        canvas.dataset.ready='true';
        canvas.dataset.state=motion.matches?'reduced-motion':'running';
      }
      function tick(){
        if(disposed||document.hidden)return;
        const now=performance.now();
        if(!motion.matches)time+=Math.min((now-last)/1000,.1)*3;
        last=now;draw();
        if(!motion.matches)timer=setTimeout(tick,innerWidth<1024?84:50);
      }
      try {
        const vertex='attribute vec2 p;varying vec2 uv;void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}';
        const fragment="precision mediump float;varying vec2 uv;uniform sampler2D picture;uniform float clock;uniform vec2 ratio;uniform float extraStars;\n float hash(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}\n float starlight(vec2 p){vec2 grid=p*vec2(70.,46.);vec2 cell=floor(grid);float seed=hash(cell);vec2 center=vec2(.2+.6*hash(cell+3.7),.2+.6*hash(cell+9.2));float d=length(fract(grid)-center);float size=mix(.027,.064,seed);float point=1.-smoothstep(size*.15,size,d);float halo=(1.-smoothstep(size,size*2.5,d))*.08;float shine=.75+.25*sin(clock*.45+seed*6.283);return (point+halo)*step(.87,seed)*shine;}\n\n void main(){vec2 q=vec2(uv.x,1.-uv.y);q=(q-.5)*ratio*.88+.5;\n float t=clock*.18;\n vec2 current=vec2(sin(q.y*7.+t)+.35*sin(q.y*15.-t*.6),cos(q.x*6.-t*.7)+.3*sin(q.x*13.+t));\n q+=current*.014;\n float eddy=sin(q.x*9.+q.y*5.-t)*.006;\n q+=vec2(eddy,-eddy*.55);\n vec3 color=texture2D(picture,clamp(q,.005,.995)).rgb;\n color+=extraStars*starlight(q)*vec3(.45,.56,.75);\n gl_FragColor=vec4(color*.85,1.);}";
        function shader(type,source){const x=gl.createShader(type);shaders.push(x);gl.shaderSource(x,source);gl.compileShader(x);if(!gl.getShaderParameter(x,gl.COMPILE_STATUS))throw Error('Shader compilation failed');return x;}
        program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vertex));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Shader linking failed');gl.useProgram(program);
        buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
        const pos=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
        texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
        for(const param of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,param,gl.CLAMP_TO_EDGE);
        for(const param of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,param,gl.LINEAR);
        clockLocation=gl.getUniformLocation(program,'clock');ratioLocation=gl.getUniformLocation(program,'ratio');gl.uniform1f(gl.getUniformLocation(program,'extraStars'),1);
        image.onload=()=>{if(disposed)return;try{gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,image);aspect=image.width/image.height;ready=true;restart();}catch(error){cleanup();}};
        image.onerror=()=>{canvas.dataset.state='asset-error';cleanup();};
        document.addEventListener('visibilitychange',restart,{signal:api.signal});
        motion.addEventListener('change',restart,{signal:api.signal});
        window.addEventListener('resize',draw,{signal:api.signal});
        canvas.addEventListener('webglcontextlost',lost,{signal:api.signal});
        api.signal.addEventListener('abort',cleanup,{once:true});
        if(api.signal.aborted){cleanup();return cleanup;}
        Promise.resolve(api.asset('assets/cold-blue-galaxy.webp')).then(url=>{if(!disposed)image.src=url;}).catch(()=>{canvas.dataset.state='asset-error';cleanup();});
      } catch(error){canvas.dataset.state='render-error';cleanup();}
      return cleanup;
    }, []);
    return React.createElement('span',{ref,hidden:true,'aria-hidden':true});
  }
  return api.slots.register({id:'stellar-flow',title:'冷蓝银河',slot:'workspace-top',render:()=>React.createElement(GalaxyBackground)});
}
