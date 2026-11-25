const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const equalityMethods = new Set([
  'equal', 'strictEqual', 'deepEqual', 'deepStrictEqual',
  'notEqual', 'notStrictEqual', 'notDeepEqual', 'notDeepStrictEqual',
])

function findDomAssertionRisks(ts, program, files) {
  const checker = program.getTypeChecker()
  function containsDom(type, seen = new Set()) {
    if (seen.has(type)) return false
    seen.add(type)
    if (type.isUnion()) return type.types.some(member => containsDom(member, seen))
    if (checker.isArrayType(type) || checker.isTupleType(type)
      || ['Map', 'Set', 'ReadonlyMap', 'ReadonlySet'].includes(type.getSymbol()?.getName())) {
      return checker.getTypeArguments(type).some(member => containsDom(member, seen))
    }
    return Boolean(type.getProperty('nodeType') && type.getProperty('cloneNode'))
      || Boolean(type.getProperty('document') && type.getProperty('location'))
      || /^(NodeList|HTMLCollection)/.test(checker.typeToString(type))
  }
  const risks = []
  for (const file of files) {
    const source = program.getSourceFile(file)
    const namespaces = new Set()
    const methods = new Set()
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && /^node:assert(?:\/strict)?$/.test(statement.moduleSpecifier.text)) {
        const clause = statement.importClause
        if (clause?.name) namespaces.add(clause.name.text)
        const bindings = clause?.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
        if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
          const name = (binding.propertyName ?? binding.name).text
          if (name === 'strict') namespaces.add(binding.name.text)
          if (equalityMethods.has(name)) methods.add(binding.name.text)
        }
      }
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer
        if (ts.isIdentifier(declaration.name) && value && ts.isCallExpression(value)
          && value.expression.getText(source) === 'require'
          && value.arguments[0] && ts.isStringLiteral(value.arguments[0])
          && /^node:assert(?:\/strict)?$/.test(value.arguments[0].text)) namespaces.add(declaration.name.text)
      }
    }
    function isEquality(expression) {
      if (ts.isIdentifier(expression)) return methods.has(expression.text)
      if (!ts.isPropertyAccessExpression(expression) || !equalityMethods.has(expression.name.text)) return false
      const receiver = expression.expression
      return ts.isIdentifier(receiver) && namespaces.has(receiver.text)
        || ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'strict'
          && ts.isIdentifier(receiver.expression) && namespaces.has(receiver.expression.text)
    }
    function visit(node) {
      if (ts.isCallExpression(node) && isEquality(node.expression)
        && node.arguments.slice(0, 2).some(argument => containsDom(checker.getTypeAtLocation(argument)))) {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
        risks.push({ file, line: line + 1, column: character + 1 })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return risks
}

function checkProject(projectDir) {
  const directory = path.resolve(projectDir)
  const ts = createRequire(path.join(directory, 'package.json'))('typescript')
  const files = ts.sys.readDirectory(path.join(directory, 'tests'), ['.ts', '.tsx', '.js', '.mjs', '.cjs'], undefined, ['**/*.test.*'])
  const program = ts.createProgram(files, {
    allowJs: true, checkJs: true, strictNullChecks: true, skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  })
  return findDomAssertionRisks(ts, program, files)
}

module.exports = { findDomAssertionRisks, checkProject }

if (require.main === module) {
  const risks = checkProject(process.argv[2] ?? '.')
  for (const risk of risks) console.error(`${path.relative(process.cwd(), risk.file)}:${risk.line}:${risk.column}: convert DOM equality assertions to booleans or primitive values`)
  console.log(`DOM assertion check: ${risks.length} unsafe assertions`)
  if (risks.length) process.exitCode = 1
}
