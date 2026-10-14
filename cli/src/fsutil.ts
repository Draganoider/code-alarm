import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes through a temporary file and a rename, so a hook killed halfway, or two hooks at once,
 * never leave a half-written file behind.
 */
export function writeFileAtomic(path: string, data: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, data, mode === undefined ? undefined : { mode });
  renameSync(temp, path);
}
