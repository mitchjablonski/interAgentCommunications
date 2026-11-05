#!/usr/bin/env node
// Deprecated alias of `iac` (the project was called agora before 0.3.0). Same commands,
// same store. The notice is interactive-only: hooks and MCP stay silent.
import { deprecationNotice } from '../src/env.js';
import { main } from '../src/cli.js';
const argv = process.argv.slice(2);
deprecationNotice('agora', 'iac', argv);
// Piped stdout/stderr write async; exiting early truncates output at the pipe buffer (~64 KiB).
const exit = (code) => process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
main(argv).then((code) => exit(code ?? 0), (e) => {
  console.error(e?.stack || String(e));
  exit(1);
});
