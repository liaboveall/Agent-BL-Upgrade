import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { validateUserConfigZodType } from '@nomicfoundation/hardhat-zod-utils';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('Hardhat configuration diagnostics with the patched Zod dependency', () => {
  it('reports the invalid field and accepts valid configuration', () => {
    const schema = z.object({ networks: z.record(z.string(), z.object({ url: z.string() })) });
    const issues = validateUserConfigZodType({ networks: { bad: { url: 123 } } }, schema);
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].path, ['networks', 'bad', 'url']);
    assert.match(issues[0].message, /string/iu);
    assert.deepEqual(validateUserConfigZodType({ networks: { good: { url: 'https://example.test' } } }, schema), []);
  });

  it('prints a configuration error from the CLI instead of crashing', async function () {
    this.timeout(20000);
    const cache = path.join(root, 'cache');
    await fs.mkdir(cache, { recursive: true });
    const config = path.join(cache, `invalid-zod-${process.pid}.config.mjs`);
    await fs.writeFile(config, "export default { networks: { bad: { type: 'http', url: 123 } } };\n");
    try {
      const run = spawnSync(process.execPath, ['node_modules/hardhat/dist/src/cli.js', '--config', config, 'build'], {
        cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true
      });
      assert.ifError(run.error);
      assert.notEqual(run.status, 0);
      const output = run.stdout + run.stderr;
      assert.match(output, /HHE15|Invalid config/iu);
      assert.match(output, /networks\.bad\.url/u);
      assert.doesNotMatch(output, /TypeError|Cannot read properties of undefined/u);
    } finally {
      await fs.unlink(config);
    }
  });
});
