#!/usr/bin/env node
// Owner-signed approvals for the agent runtime. See scripts/lib/agent-approve.mjs and
// docs/agent-implementation-plan.md (WP1.3).
import '../src/env.js';
import { run } from './lib/agent-approve.mjs';

process.exitCode = await run({ argv: process.argv.slice(2), env: process.env });
