import assert from 'node:assert/strict'
import test from 'node:test'
import {PrototypeFrameRouting} from '../src/components/prototype/prototypeFrameRouting'
const root={version:'a1',nodes:{},html_preview:{token:'ticket',entry:'a.html'}}
const child={version:'b1',nodes:{n1:{editable:true,text_editable:true,line:1}},html_preview:{token:'ticket',entry:'b.html'}}
const packet={token:'ticket',path:'b.html',route:[0],document:child,frames:[{file:'a.html',selector:'iframe#content'}]}
test('frame routes authenticate per-file versions, reject stale and unknown frames, and retain nested navigation',()=>{
 const router=new PrototypeFrameRouting(),files=new Set(['a.html','b.html','c.html'])
 assert.equal(router.accept({...packet,token:'forged'},root,files,true),null)
 assert.equal(router.accept({...packet,path:'outside.html'},root,files,true),null)
 assert.equal(router.accept(packet,root,files,true),'loaded')
 const event={...packet,version:'b1'}
 assert.equal(router.resolve({...event,version:'a1'},root),null)
 assert.equal(router.resolve({...event,route:[1]},root),null)
 const target=router.resolve(event,root)!
 router.select(target)
 assert.equal(router.active?.path,'b.html')
 assert.equal(router.accept({...packet,path:'c.html',document:{...child,version:'c1',html_preview:{...child.html_preview,entry:'c.html'}}},root,files,false),'loaded')
 assert.equal(router.accept(packet,root,files,true),'restore','select mode restores current route instead of initial iframe src')
 assert.equal(router.saved[0].path,'c.html')
 router.reset()
 assert.equal(router.active,undefined)
 assert.deepEqual(router.saved,[])
})
