import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveApplicationConfig } from './applicationConfig.js';

export const applicationConfigPath = path.resolve(import.meta.dirname, '../../public/application-config.json');
export function loadApplicationConfig(network) {
  return resolveApplicationConfig(JSON.parse(readFileSync(applicationConfigPath, 'utf8')), network);
}
