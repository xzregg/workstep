import { useEffect, useRef } from 'react'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import cpp from 'highlight.js/lib/languages/cpp'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('go', go)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('java', java)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: 'bash', c: 'cpp', cc: 'cpp', cpp: 'cpp', css: 'css', go: 'go', h: 'cpp', hpp: 'cpp',
  htm: 'xml', html: 'xml', java: 'java', js: 'typescript', jsx: 'typescript', json: 'json',
  md: 'markdown', mjs: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', sql: 'sql',
  toml: 'ini', ts: 'typescript', tsx: 'typescript', xml: 'xml', yaml: 'yaml', yml: 'yaml', zsh: 'bash',
}

interface CodeFilePreviewProps {
  filename: string
  content: string
  line?: number
}

export function languageForFilename(filename: string): string {
  const extension = filename.split('.').at(-1)?.toLowerCase() ?? ''
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext'
}

export function highlightedLines(filename: string, content: string): { language: string; lines: string[] } {
  const language = languageForFilename(filename)
  const value = language === 'plaintext'
    ? hljs.highlightAuto(content, []).value
    : hljs.highlight(content, { language, ignoreIllegals: true }).value
  return { language, lines: value.split('\n') }
}

export default function CodeFilePreview({ filename, content, line }: CodeFilePreviewProps) {
  const targetRef = useRef<HTMLSpanElement>(null)
  const { language, lines } = highlightedLines(filename, content)

  useEffect(() => {
    targetRef.current?.scrollIntoView({ block: 'center' })
  }, [line, content])

  return (
    <div className="code-preview" data-language={language}>
      <div className="code-preview-language">{language}</div>
      <pre className="code-preview-scroll" tabIndex={0}>
        <code>
          {lines.map((highlightedLine, index) => (
            <span
              className={`code-preview-line${line === index + 1 ? ' is-target' : ''}`}
              data-line={index + 1}
              ref={line === index + 1 ? targetRef : undefined}
              key={index}
            >
              <span className="code-preview-line-number" aria-hidden="true">{index + 1}</span>
              <span
                className="code-preview-line-content"
                dangerouslySetInnerHTML={{ __html: highlightedLine || ' ' }}
              />
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
