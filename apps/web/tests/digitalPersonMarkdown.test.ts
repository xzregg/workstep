import test from 'node:test'
import assert from 'node:assert/strict'
import {documentSection,personaDocument,setDocumentSection,toggleDocumentItem,withPersonaDocument} from '../src/components/digital-person/digitalPersonMarkdown'
import type {DigitalPersonProfile} from '../src/api/digitalPerson'

const profile:DigitalPersonProfile={enabled:true,name:'小研',role:'私人助理',personality:'耐心、好奇',tone:'简短直接',relationship_preferences:'不要叫我老板。',duties:'跟进事项',avatar:'robot',greeting:'你好'}
test('legacy identity fields all appear in the initial Markdown without mutating the saved configuration',()=>{
 const text=personaDocument(profile,undefined,'温和')
 for(const value of ['私人助理','耐心、好奇','简短直接','不要叫我老板。','温和','你好'])assert.ok(text.includes(value))
 assert.equal(profile.persona_markdown,undefined)
 assert.equal(personaDocument({...profile,persona_markdown:''}),'','an explicitly cleared document does not restore legacy text')
})
test('preset changes replace one section, preserve custom sections and support toggle removal',()=>{
 const text='用户前言\n\n## 身份\n私人助理\n\n## 我的要求\n保留我的措辞。\n\n## 性格\n- 耐心\n- 自填性格\n'
 const next=toggleDocumentItem(setDocumentSection(text,'role',['研发伙伴']),'personality','好奇')
 assert.ok(next.startsWith('用户前言'));assert.ok(next.includes('## 我的要求\n保留我的措辞。'))
 assert.deepEqual(documentSection(next,'role'),['研发伙伴'])
 assert.deepEqual(documentSection(next,'personality'),['耐心','自填性格','好奇'])
 assert.deepEqual(documentSection(toggleDocumentItem(next,'personality','好奇'),'personality'),['耐心','自填性格'])
})
test('editing Markdown synchronizes compatibility labels and never appends text to the other documents',()=>{
 const next=withPersonaDocument(profile,'## 身份\n研发伙伴\n\n## 语气\n温和亲切\n\n## 额外要求\n自定义')
 assert.equal(next.role,'研发伙伴');assert.equal(next.tone,'温和亲切')
 assert.equal(next.duties,profile.duties);assert.equal(next.conversation_rules,profile.conversation_rules)
 assert.equal(next.role_binding,null)
 assert.ok(next.persona_markdown?.includes('自定义'))
})

test('changing the UI language updates the same Markdown section and preserves handwritten content',()=>{
 const french={role:'Identité',personality:'Caractère',tone:'Ton',relationship:'Relation',greeting:'Message d’accueil',duties:'Responsabilités principales',boundary:'Limite d’exécution',memory:'Accords permanents'}
 const text='## Identité\nAssistant\n\n## Notes personnelles\nConserver ce texte.'
 const next=setDocumentSection(text,'role',['研发伙伴'])
 assert.equal((next.match(/^## /gm)||[]).length,2)
 assert.ok(next.includes('Conserver ce texte.'))
 assert.deepEqual(documentSection(next,'role',french),['研发伙伴'])
})

test('preset toggles keep list continuations, blank lines and fenced examples verbatim',()=>{
 const text='## 主要职责\n\n- 跟进事项\n  每周一次\n\n```md\n- 跟进事项\n## 主要职责\n```\n\n## 补充\n请确认。'
 const added=toggleDocumentItem(text,'duties','跟进事项')
 assert.ok(added.includes('  每周一次\n\n```md\n- 跟进事项\n## 主要职责\n```'))
 assert.equal(toggleDocumentItem(added,'duties','跟进事项'),text)
})

test('clearing the tone and personality chapters clears their saved speech fields',()=>{
 const next=withPersonaDocument(profile,'## 语气\n\n## 额外要求\n自定义')
 assert.equal(next.tone,'')
 assert.equal(next.personality,'')
})
