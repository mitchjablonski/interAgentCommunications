#!/usr/bin/env node
import { main } from '../src/cli.js';
// Piped stdout/stderr write async; exiting early truncates output at the pipe buffer (~64 KiB).
const exit = (code) => process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
main(process.argv.slice(2)).then((code) => exit(code ?? 0), (e) => {
  console.error(e?.stack || String(e));
  exit(1);
});
