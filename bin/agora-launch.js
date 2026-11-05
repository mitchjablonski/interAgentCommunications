#!/usr/bin/env node
// Deprecated alias of `iac-launch`. Same arguments.
import { deprecationNotice } from '../src/env.js';
deprecationNotice('agora-launch', 'iac-launch', process.argv.slice(2));
await import('./iac-launch.js');
