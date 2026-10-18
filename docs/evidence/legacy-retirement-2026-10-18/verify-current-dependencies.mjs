// Read-only static import / npm-script audit; does not start the application or load .env.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parse } from 'espree';

const root = path.resolve(import.meta.dirname, '../../..');
const require = createRequire(import.meta.url);
const files = [];
async function walk(directory) {
  for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    if (['vendor', 'node_modules', 'artifacts', 'cache', 'dist'].includes(entry.name)) continue;
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await walk(name);
    else if (/\.(?:[cm]?js|jsx)$/u.test(name)) files.push(name);
  }
}
for (const directory of ['src', 'web/src', 'scripts', 'tests', 'hardhat/test']) await walk(directory);
const issues = [];
let imports = 0;
for (const file of files) {
  const ast = parse(await fs.readFile(path.join(root, file), 'utf8'), {
    ecmaVersion: 'latest', sourceType: file.endsWith('.cjs') ? 'commonjs' : 'module', ecmaFeatures: { jsx: true }
  });
  const targets = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)
      && typeof node.source?.value === 'string') targets.push(node.source.value);
    if (node.type === 'CallExpression' && node.callee?.name === 'require' && typeof node.arguments?.[0]?.value === 'string') targets.push(node.arguments[0].value);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  for (const target of targets.filter((name) => name.startsWith('.'))) {
    imports++;
    const resolved = path.resolve(root, path.dirname(file), target);
    const found = await fs.access(resolved).then(() => true, () => false);
    if (!found) issues.push({ file, target, issue: 'missing_relative_import' });
  }
}
for (const file of ['package.json', 'hardhat/package.json']) {
  const config = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
  for (const [command, body] of Object.entries(config.scripts)) {
    for (const match of body.matchAll(/(?:^|\s)([\w./-]+\.(?:mjs|cjs|js))(?=\s|$)/gu)) {
      const target = path.resolve(root, path.dirname(file), match[1]);
      if (!await fs.access(target).then(() => true, () => false)) issues.push({ file, command, target: match[1], issue: 'missing_command_target' });
    }
  }
}
const retired = JSON.parse(await fs.readFile(path.join(import.meta.dirname, 'retired-files.json'), 'utf8'));
for (const file of retired.files) {
  if (await fs.access(path.join(root, file.path)).then(() => true, () => false)) issues.push({ file: file.path, issue: 'retired_file_present' });
}
// Resolver availability is recorded separately from the source import walk.
require.resolve('espree');
const result = { schema: 'agentbl-retirement-static-dependencies-v1', checked_at: new Date().toISOString(),
  source_files_parsed: files.length, relative_imports_checked: imports, npm_packages_checked: 2,
  retired_files_checked: retired.files.length, issues, passed: issues.length === 0,
  scope: 'Literal static/dynamic imports and requires, direct npm JS command targets; runtime-generated paths are covered by regression tests' };
await fs.writeFile(path.join(import.meta.dirname, 'dependency-check.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
