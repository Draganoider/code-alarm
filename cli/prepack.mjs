// Copies the repository's LICENSE and README into the package before `npm pack` or `npm publish`.
// The README's links and images are relative to the repository root, which npm can't resolve, so
// they're pointed at GitHub: images at the raw files on main, links at the files' pages.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const RAW = "https://raw.githubusercontent.com/Draganoider/code-alarm/main/";
const PAGE = "https://github.com/Draganoider/code-alarm/blob/main/";

/** Rewrites src="…", href="…" and markdown (…) targets that are relative paths. */
export function absoluteLinks(readme) {
  const relative = (target) => !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target);
  return readme
    .replace(/\bsrc="([^"]+)"/g, (all, target) => (relative(target) ? `src="${RAW}${target}"` : all))
    .replace(/\bhref="([^"]+)"/g, (all, target) => (relative(target) ? `href="${PAGE}${target}"` : all))
    .replace(/(!?)\]\(([^)\s]+)\)/g, (all, bang, target) => (relative(target) ? `${bang}](${bang ? RAW : PAGE}${target})` : all));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  copyFileSync(join(root, "LICENSE"), join(here, "LICENSE"));
  writeFileSync(join(here, "README.md"), absoluteLinks(readFileSync(join(root, "README.md"), "utf8")));
}
