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
