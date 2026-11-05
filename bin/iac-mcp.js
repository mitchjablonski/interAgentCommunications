#!/usr/bin/env node
import { startMcp } from '../src/mcp.js';
// The store comes from IAC_HOME (or the legacy AGORA_HOME), then the default resolution.
startMcp({});
