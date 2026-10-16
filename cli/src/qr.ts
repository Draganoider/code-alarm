import { qrcodegen } from "./vendor/qrcodegen.js";

/** The modules of a QR code for `text`: true is dark. Medium error correction survives a glare. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const rows: boolean[][] = [];
  for (let y = 0; y < qr.size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < qr.size; x++) row.push(qr.getModule(x, y));
    rows.push(row);
  }
  return rows;
}

const QUIET = 2;

/**
 * A QR code for a terminal: two module rows per text line, with half-block characters. Colours
 * are forced to black on white, because scanners want dark modules on a light background and many
 * terminals are dark.
 */
export function qrForTerminal(text: string): string {
  const modules = qrModules(text);
  const size = modules.length + QUIET * 2;
  const dark = (x: number, y: number) => {
    const mx = x - QUIET;
    const my = y - QUIET;
    return mx >= 0 && my >= 0 && mx < modules.length && my < modules.length && modules[my]![mx]!;
  };
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = "";
    for (let x = 0; x < size; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < size && dark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    // Black foreground on a white background, reset at the end of each line.
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines.join("\n");
}
