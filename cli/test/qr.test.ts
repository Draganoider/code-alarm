import assert from "node:assert/strict";
import { test } from "node:test";
import { qrForTerminal, qrModules } from "../src/qr.js";

const URL_TEXT = "HTTPS://RELAY.CODEALARM.WORKERS.DEV/PAIR/K7Q-4MZ";

test("the pairing URL in upper case makes a version 3 code, 29 modules", () => {
  assert.equal(qrModules(URL_TEXT).length, 29);
});

test("the code has its three finder patterns", () => {
  const m = qrModules(URL_TEXT);
  const n = m.length;
  // A finder: a 7x7 dark ring, a light ring, and a 3x3 dark centre.
  const finderAt = (x0: number, y0: number) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const ring = x === 0 || y === 0 || x === 6 || y === 6;
        const centre = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        if (m[y0 + y]![x0 + x] !== (ring || centre)) return false;
      }
    }
    return true;
  };
  assert.ok(finderAt(0, 0));
  assert.ok(finderAt(n - 7, 0));
  assert.ok(finderAt(0, n - 7));
});

test("the terminal version packs two rows per line, black on white, with a quiet zone", () => {
  const lines = qrForTerminal(URL_TEXT).split("\n");
  assert.equal(lines.length, Math.ceil((29 + 4) / 2));
  for (const line of lines) {
    assert.ok(line.startsWith("\x1b[30;47m") && line.endsWith("\x1b[0m"));
    assert.equal(line.replace(/\x1b\[[0-9;]*m/g, "").length, 29 + 4);
  }
  // The quiet zone: the first line is blank.
  assert.equal(lines[0]!.replace(/\x1b\[[0-9;]*m/g, "").trim(), "");
});
