import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

export const tempStore = () => new Store(mkdtempSync(join(tmpdir(), "mem-")));
