#!/usr/bin/env node
import { startMcp } from "./mcp.js";

startMcp().catch((e) => {
  console.error(e);
  process.exit(1);
});
