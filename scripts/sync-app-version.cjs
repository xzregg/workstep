// Desktop package.json is the release version source; mirror Python package metadata.
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')).version
for (const [file, pattern] of [
  ['apps/daemon/pyproject.toml', /^(version = ")[^"]+("$)/m],
  ['apps/daemon/uv.lock', /(name = "workstep-daemon"\nversion = ")[^"]+("$)/m],
]) {
  const target = path.join(root, file)
  const source = fs.readFileSync(target, 'utf8')
  if (!pattern.test(source)) throw new Error(`Missing version in ${file}`)
  fs.writeFileSync(target, source.replace(pattern, (_, before, after) => before + version + after))
}
