#!/usr/bin/env node
// Stands in for `npx stryker run <config>` in tests: it records every config it is given in
// stryker-calls.json (in the project root, where SpecPilot runs it) and writes a JSON report whose
// mutants come from stryker-mutants.json ({ "<file>": [<Stryker mutant>, ...] }). If
// stryker-mutants.json is the string "no-report", it writes no report at all (and exits 0, so only the
// missing report is wrong). If stryker-exit.json holds a number, it exits with that status after
// writing the report, like a Stryker run that failed part way.
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'));
const calls = fs.existsSync('stryker-calls.json') ? JSON.parse(fs.readFileSync('stryker-calls.json', 'utf8')) : [];
calls.push(config);
fs.writeFileSync('stryker-calls.json', JSON.stringify(calls, null, 2));

const exitStatus = fs.existsSync('stryker-exit.json') ? JSON.parse(fs.readFileSync('stryker-exit.json', 'utf8')) : 0;
const plan = fs.existsSync('stryker-mutants.json') ? JSON.parse(fs.readFileSync('stryker-mutants.json', 'utf8')) : {};
if (plan === 'no-report') process.exit(exitStatus);

const files = {};
for (const file of config.mutate) files[file] = { language: 'javascript', source: '', mutants: plan[file] || [] };
fs.writeFileSync(config.jsonReporter.fileName, JSON.stringify({ schemaVersion: '1', files }));
process.exit(exitStatus);
