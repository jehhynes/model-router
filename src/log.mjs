import fs from 'node:fs';
import path from 'node:path';

/** Returns a function that writes a timestamped line to `file`, or to stdout when `file` is omitted.
 * When a line would take the file past `maxBytes`, the file becomes `<file>.1` first, `<file>.1` becomes `<file>.2`,
 * and so on; at most `maxFiles` of these older files are kept. */
export function createLog({
  file,
  maxBytes = 10 * 1024 * 1024,
  maxFiles = 5,
  now = () => new Date(),
  ignoreCase = process.platform === 'win32',
} = {}) {
  // Synchronous writes, so the line that explains an exit is written before it.
  if (!file)
    return line => {
      try {
        fs.writeSync(1, `${now().toISOString()} ${line}\n`);
      } catch {
        // No output is left to report to; routing continues.
      }
    };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // Each append then fails and reports to stderr.
  }
  return line => {
    const entry = `${now().toISOString()} ${line}\n`;
    const size = sizeOf(file);
    if (size > 0 && size + Buffer.byteLength(entry) > maxBytes) {
      try {
        rotate(file, maxFiles, ignoreCase);
      } catch {
        // A file another program holds open cannot be renamed on Windows; keep appending and retry on the next line.
      }
    }
    try {
      fs.appendFileSync(file, entry);
    } catch (err) {
      try {
        fs.writeSync(2, `${entry.trimEnd()} (not written to ${file}: ${err.message})\n`);
      } catch {
        // No output is left to report to; routing continues.
      }
    }
  };
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function rotate(file, maxFiles, ignoreCase) {
  // Moving the active file aside first means a file held open fails the rotation before any older file changes.
  // A `.0` left by an earlier failed attempt is finished first, and the active file rotates on a later line.
  const staged = `${file}.0`;
  if (!fs.existsSync(staged))
    fs.renameSync(file, staged);

  const dir = path.dirname(file);
  const fold = name => ignoreCase ? name.toLowerCase() : name;
  const prefix = fold(`${path.basename(file)}.`);
  // Removes files left over from a larger maxFiles.
  for (const name of fs.readdirSync(dir)) {
    const suffix = fold(name).startsWith(prefix) ? name.slice(prefix.length) : '';
    if (/^[1-9][0-9]*$/.test(suffix) && Number(suffix) > maxFiles)
      fs.rmSync(path.join(dir, name), { force: true });
  }
  if (maxFiles === 0)
    return fs.rmSync(staged, { force: true });

  // Shifting only up to the first missing number means a retry after a partly done shift deletes nothing more.
  let free = 1;
  while (free <= maxFiles && fs.existsSync(`${file}.${free}`))
    free++;
  if (free > maxFiles) {
    fs.rmSync(`${file}.${maxFiles}`, { force: true });
    free = maxFiles;
  }
  for (let n = free - 1; n >= 1; n--)
    fs.renameSync(`${file}.${n}`, `${file}.${n + 1}`);
  fs.renameSync(staged, `${file}.1`);
}
