#!/usr/bin/env node
// Deprecated alias of `iac-mcp`. Silent: an MCP server's stderr is not for people.
import { startMcp } from '../src/mcp.js';
startMcp({});
