import fs from 'node:fs/promises';
const budgets = { RWAOfferingPoolV5: 24367, RightsController: 24374 };
const results = [];
for (const [name, reviewedBudget] of Object.entries(budgets)) {
  const artifact = JSON.parse(await fs.readFile(new URL(`../hardhat/artifacts/contracts/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
  const bytes = (artifact.deployedBytecode.length - 2) / 2;
  results.push({ contract: name, runtime_bytes: bytes, eip170_remaining: 24576 - bytes, reviewed_budget: reviewedBudget });
  if (bytes > reviewedBudget) process.exitCode = 1;
}
console.log(JSON.stringify({ scope: 'compiled runtime; existing deployed contracts are unchanged', contracts: results }, null, 2));
if (process.exitCode) console.error('Contract size grew beyond the reviewed budget. Review module boundaries and migration before updating the budget.');
