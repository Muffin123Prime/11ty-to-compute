#!/usr/bin/env node
'use strict';

/**
 * Test runner. No dependencies, no config.
 *   node test/run.js            run everything
 *   node test/run.js store      run files matching 'store'
 */

const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness');

const filter = process.argv[2] || '';
const dir = __dirname;

function discover(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...discover(full));
    else if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out.sort();
}

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';

async function main() {
  const files = discover(dir).filter((f) => !filter || f.includes(filter));
  if (!files.length) {
    console.log('No test files found.');
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  const failures = [];
  const started = Date.now();

  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    let suite;
    try {
      const mod = require(file);
      const inline = harness.drain();
      suite = {
        name: (mod && mod.name) || path.basename(file, '.test.js'),
        tests: (mod && mod.tests) || inline,
      };
    } catch (err) {
      failed++;
      failures.push({ suite: rel, test: '<module load>', err });
      console.log(`${RED}✗${RESET} ${rel} ${DIM}(failed to load)${RESET}`);
      console.log(`  ${RED}${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : err}${RESET}`);
      continue;
    }

    if (!suite.tests || !suite.tests.length) {
      console.log(`${YELLOW}—${RESET} ${rel} ${DIM}(no tests)${RESET}`);
      continue;
    }

    console.log(`${DIM}${rel}${RESET}`);
    for (const t of suite.tests) {
      const t0 = Date.now();
      try {
        await Promise.resolve(t.fn({}));
        passed++;
        const ms = Date.now() - t0;
        console.log(`  ${GREEN}✓${RESET} ${t.name} ${DIM}${ms}ms${RESET}`);
      } catch (err) {
        failed++;
        failures.push({ suite: rel, test: t.name, err });
        console.log(`  ${RED}✗ ${t.name}${RESET}`);
      }
    }
  }

  const ms = Date.now() - started;
  console.log('');
  if (failures.length) {
    console.log(`${RED}${failures.length} failure(s):${RESET}\n`);
    for (const f of failures) {
      console.log(`${RED}● ${f.suite} → ${f.test}${RESET}`);
      const stack = f.err && f.err.stack ? f.err.stack : String(f.err);
      console.log(stack.split('\n').slice(0, 8).map((l) => '  ' + l).join('\n'));
      console.log('');
    }
  }
  const verdict = failed ? `${RED}FAIL${RESET}` : `${GREEN}PASS${RESET}`;
  console.log(`${verdict}  ${passed} passed, ${failed} failed  ${DIM}${ms}ms${RESET}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
