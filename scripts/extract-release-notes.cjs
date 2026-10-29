#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

try {
  const [tag, filename = path.resolve(__dirname, '../CHANGELOG.md')] = process.argv.slice(2)
  if (!/^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(tag || '')) {
    throw new Error('A semantic-version tag such as v1.0.16 is required')
  }
  const sections = fs.readFileSync(filename, 'utf8').split(/^## /m).slice(1)
  const matches = sections.filter(section => section.split('\n', 1)[0].trim() === tag.slice(1))
  if (matches.length !== 1) throw new Error(`Expected one changelog section for ${tag}`)
  const body = matches[0].slice(matches[0].indexOf('\n') + 1).trim()
  if (!body) throw new Error(`Release notes for ${tag} are empty`)
  if (/\p{Script=Han}/u.test(body)) throw new Error('Release notes must use English prose')
  process.stdout.write(`${body}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
