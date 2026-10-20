import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function makeTempDir(prefix = "agy-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
