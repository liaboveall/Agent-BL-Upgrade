import fs from 'node:fs/promises';
import path from 'node:path';
import { createRuntimeBackup, restoreRuntimeBackup } from '../src/ops/backup.js';

// Does not load .env. The recovery key must be supplied as an independent file.
const [operation, ...args] = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!/^--(?:directory|output|input|key-file|configuration|revision)$/u.test(args[i]) || !args[i + 1]) throw new Error('Invalid backup argument');
  options[args[i].slice(2)] = args[i + 1];
}
if (!['create', 'restore'].includes(operation) || !options.directory || !options['key-file']) throw new Error('Use create/restore --directory <path> --key-file <external key file> --output/--input <encrypted backup>');
const key = Buffer.from((await fs.readFile(path.resolve(options['key-file']), 'utf8')).trim(), 'hex');
const result = operation === 'create' ? await createRuntimeBackup({ directory: options.directory, output: options.output, key,
  configuration: options.configuration ? JSON.parse(await fs.readFile(options.configuration, 'utf8')) : {}, sourceRevision: options.revision })
  : await restoreRuntimeBackup({ input: options.input, directory: options.directory, key });
console.log(JSON.stringify(result, null, 2));
