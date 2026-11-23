import assert from 'node:assert/strict'
import test from 'node:test'
import {constellationLinks} from '../src/components/digital-person/memoryConstellation'

const link=(from:string,to:string)=>({from,to})
const point=(x:number,y:number)=>({x,y})

test('nearby sides make an open chain and diagonals stay out',()=>{
  const points=new Map([['a',point(0,0)],['b',point(10,0)],['c',point(10,10)],['d',point(0,10)]])
  const neighbours=[link('a','b'),link('b','c'),link('c','d')]
  const candidates=[link('a','c'),link('b','d'),...neighbours,link('d','a')]
  assert.deepEqual(constellationLinks(candidates,points,30),neighbours)
})

test('only the shorter crossing segment survives and distant links stay hidden',()=>{
  const points=new Map([
    ['a',point(0,0)],['b',point(10,10)],['c',point(0,6)],['d',point(8,2)],['e',point(60,50)],
  ])
  assert.deepEqual(constellationLinks([link('a','b'),link('a','e'),link('c','d')],points,20),[link('c','d')])
})

test('stars stay on short open chains even if a single star has many links',()=>{
  const points=new Map([
    ['a',point(0,0)],['b',point(0,4)],['c',point(3,0)],['d',point(-4,0)],['e',point(8,0)],
  ])
  assert.deepEqual(constellationLinks([link('a','b'),link('a','c'),link('a','d'),link('a','e')],points,12),
    [link('a','c'),link('a','b')])
})

test('focusing a star shows only its own nearby chain',()=>{
  const points=new Map([
    ['a',point(0,0)],['b',point(0,4)],['c',point(0,8)],['d',point(20,0)],['e',point(20,4)],
  ])
  const chain=[link('a','b'),link('b','c')]
  assert.deepEqual(constellationLinks([link('d','e'),...chain],points,12,new Set(),'a'),chain)
})

test('focusing a star extends its visible chain beyond the recall distance cutoff',()=>{
  const points=new Map([
    ['a',point(0,0)],['b',point(80,20)],['c',point(45,35)],['d',point(50,35)],
  ])
  const edges=[link('a','b'),link('c','a'),link('c','d'),link('a','offscreen')]
  assert.deepEqual(constellationLinks(edges,points,20,new Set(),'a'),[link('c','a'),link('c','d')])
  assert.deepEqual(constellationLinks(edges,points,20),[link('c','d')])
  assert.deepEqual(constellationLinks([link('a','offscreen'),link('c','d')],points,20,new Set(),'a'),[])
  const chain=[link('a','b'),link('b','c'),link('c','d')]
  assert.deepEqual(constellationLinks(chain,new Map([
    ['a',point(0,0)],['b',point(30,0)],['c',point(60,0)],['d',point(90,0)],
  ]),10,new Set(),'a'),chain)
})

test('focused links remain one open chain when additional relations branch, cross, or close a loop',()=>{
  const points=new Map([
    ['a',point(0,0)],['b',point(4,0)],['c',point(8,0)],['d',point(4,10)],['e',point(2,-9)],['f',point(2,9)],
  ])
  const edges=[link('a','b'),link('b','c'),link('b','d'),link('a','e'),link('e','f'),link('c','a')]
  assert.deepEqual(constellationLinks(edges,points,5,new Set(),'a'),[link('a','b'),link('b','c')])
})

test('focused chains start at the selected star and stop after five hops total',()=>{
  const ids=Array.from({length:15},(_,index)=>String(index))
  const points=new Map(ids.map((id,index)=>[id,point(index*10,0)]))
  const edges=ids.slice(1).map((id,index)=>link(ids[index],id))
  assert.deepEqual(constellationLinks(edges,points,20,new Set(),'0'),edges.slice(0,5))
  assert.deepEqual(constellationLinks(edges,points,20,new Set(),'7'),edges.slice(2,7).reverse())
})
