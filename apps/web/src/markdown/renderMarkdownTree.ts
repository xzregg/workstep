import { Fragment, type ComponentProps } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import ReactMarkdown, { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { urlAttributes } from 'html-url-attributes'
import type { Element, Root } from 'hast'

/** Keep react-markdown's default escaping and URL policy on worker output. */
export function renderMarkdownTree(tree: Root, components: ComponentProps<typeof ReactMarkdown>['components'], urlTransform: UrlTransform = defaultUrlTransform) {
  const visit = (parent: Root | Element) => {
    parent.children = parent.children.map(child => {
      if (child.type === 'raw') return { type: 'text' as const, value: child.value }
      if (child.type === 'element') {
        for (const [key, tags] of Object.entries(urlAttributes)) {
          if (Object.hasOwn(child.properties, key) && (tags === null || tags.includes(child.tagName))) {
            child.properties[key] = urlTransform(String(child.properties[key] || ''), key, child)
          }
        }
        visit(child)
      }
      return child
    }) as typeof parent.children
  }
  visit(tree)
  return toJsxRuntime(tree, { Fragment, components, jsx, jsxs, passKeys: true, passNode: true, ignoreInvalidStyle: true })
}
