import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createLog } from '../src/log.mjs';

// Each line is "<24-character timestamp> <text>\n", so a 5-character text makes a 31-byte entry.
const now = () => new Date('2026-01-01T00:00:00.000Z');
const ENTRY = 31;

describe('createLog', () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-log-'));
    file = path.join(dir, 'logs', 'router.log');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const read = name => fs.readFileSync(path.join(dir, 'logs', name), 'utf8');
  const names = () => fs.readdirSync(path.join(dir, 'logs')).sort();

  it('creates the folder and appends timestamped lines', () => {
    const log = createLog({ file, now });
    log('one');
    log('two');
    assert.equal(read('router.log'), '2026-01-01T00:00:00.000Z one\n2026-01-01T00:00:00.000Z two\n');
  });

  it('rotates before a line would pass maxBytes, not when it reaches it exactly', () => {
    const log = createLog({ file, maxBytes: 2 * ENTRY, maxFiles: 3, now });
    log('line1');
    log('line2');
    assert.deepEqual(names(), ['router.log']);
    log('line3');
    assert.deepEqual(names(), ['router.log', 'router.log.1']);
    assert.match(read('router.log.1'), /line1\n.*line2\n$/);
    assert.match(read('router.log'), /^\S+ line3\n$/);
  });

  it('shifts older files up and deletes those past maxFiles', () => {
    const log = createLog({ file, maxBytes: ENTRY, maxFiles: 2, now });
    for (const n of [1, 2, 3, 4])
      log(`line${n}`);
    assert.deepEqual(names(), ['router.log', 'router.log.1', 'router.log.2']);
    assert.match(read('router.log'), /line4/);
    assert.match(read('router.log.1'), /line3/);
    assert.match(read('router.log.2'), /line2/);
  });

  it('deletes files left over from a larger maxFiles and leaves unrelated files alone', () => {
    fs.mkdirSync(path.dirname(file));
    for (const name of ['router.log.3', 'router.log.7', 'router.log.old', 'other.log.9'])
      fs.writeFileSync(path.join(dir, 'logs', name), 'x');
    const log = createLog({ file, maxBytes: ENTRY, maxFiles: 2, now });
    log('line1');
    log('line2');
    assert.deepEqual(names(), ['other.log.9', 'router.log', 'router.log.1', 'router.log.old']);
  });

  it('deletes the full log when maxFiles is 0', () => {
    const log = createLog({ file, maxBytes: ENTRY, maxFiles: 0, now });
    log('line1');
    log('line2');
    assert.deepEqual(names(), ['router.log']);
    assert.match(read('router.log'), /^\S+ line2\n$/);
  });

  it('counts a file that existed before the router started', () => {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'x'.repeat(ENTRY));
    createLog({ file, maxBytes: ENTRY, maxFiles: 1, now })('line1');
    assert.equal(read('router.log.1'), 'x'.repeat(ENTRY));
  });

  it('writes a line longer than maxBytes to an empty file instead of rotating forever', () => {
    const log = createLog({ file, maxBytes: 4, maxFiles: 1, now });
    log('line1');
    assert.deepEqual(names(), ['router.log']);
    log('line2');
    assert.match(read('router.log.1'), /line1/);
    assert.match(read('router.log'), /line2/);
  });

  it('keeps appending and leaves older files alone while the log file cannot be renamed', () => {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(`${file}.1`, 'one');
    fs.writeFileSync(`${file}.2`, 'two');
    const log = createLog({ file, maxBytes: ENTRY, maxFiles: 2, now });
    log('line1');
    // As on Windows while another program holds the log file open: only renaming that file fails.
    const rename = fs.renameSync;
    const held = mock.method(fs, 'renameSync', (from, to) => {
      if (from === file)
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      rename(from, to);
    });
    try {
      log('line2');
      log('line3');
    } finally {
      held.mock.restore();
    }
    assert.deepEqual(names(), ['router.log', 'router.log.1', 'router.log.2']);
    assert.equal(read('router.log.1'), 'one');
    assert.equal(read('router.log.2'), 'two');
    assert.match(read('router.log'), /line1\n.*line2\n.*line3\n$/);
    log('line4');
    assert.match(read('router.log.1'), /line1\n.*line2\n.*line3\n$/);
    assert.equal(read('router.log.2'), 'one');
    assert.match(read('router.log'), /^\S+ line4\n$/);
  });

  it('finishes a rotation that an earlier run left half done', () => {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(`${file}.0`, 'staged');
    fs.writeFileSync(`${file}.1`, 'one');
    fs.writeFileSync(file, 'x'.repeat(ENTRY));
    const log = createLog({ file, maxBytes: ENTRY, maxFiles: 3, now });
    log('line1');
    assert.deepEqual(names(), ['router.log', 'router.log.1', 'router.log.2']);
    assert.equal(read('router.log.1'), 'staged');
    assert.equal(read('router.log.2'), 'one');
    assert.match(read('router.log'), /x\S+ line1\n$/);
    log('line2');
    assert.match(read('router.log.1'), /line1/);
    assert.equal(read('router.log.3'), 'one');
  });

  it('keeps every older file when a retry finishes a partly done shift', () => {
    fs.mkdirSync(path.dirname(file));
    for (const n of [1, 2, 3])
      fs.writeFileSync(`${file}.${n}`, `old${n}`);
    const log = createLog({ file, maxBytes: ENTRY, maxFiles: 3, now });
    log('line1');
    const rename = fs.renameSync;
    const held = mock.method(fs, 'renameSync', (from, to) => {
      if (from === `${file}.1`)
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      rename(from, to);
    });
    try {
      log('line2'); // deletes old3, moves old2 to .3, then fails on old1
    } finally {
      held.mock.restore();
    }
    assert.deepEqual(names(), ['router.log', 'router.log.0', 'router.log.1', 'router.log.3']);
    log('line3');
    assert.deepEqual(names(), ['router.log', 'router.log.1', 'router.log.2', 'router.log.3']);
    assert.match(read('router.log.1'), /^\S+ line1\n$/);
    assert.equal(read('router.log.2'), 'old1');
    assert.equal(read('router.log.3'), 'old2');
    assert.match(read('router.log'), /line2\n.*line3\n$/);
  });

  it('reports a failed append to stderr, and does not throw when stderr fails too', () => {
    const log = createLog({ file, now });
    const written = [];
    const append = mock.method(fs, 'appendFileSync', () => {
      throw new Error('ENOSPC: no space left on device');
    });
    const write = mock.method(fs, 'writeSync', (fd, text) => {
      written.push([fd, text]);
    });
    try {
      log('line1');
      write.mock.mockImplementation(() => {
        throw new Error('EBADF: bad file descriptor');
      });
      log('line2');
    } finally {
      append.mock.restore();
      write.mock.restore();
    }
    assert.deepEqual(written, [[2, `2026-01-01T00:00:00.000Z line1 (not written to ${file}: ENOSPC: no space left on device)\n`]]);
  });

  it('deletes only canonical numbered names', () => {
    fs.mkdirSync(path.dirname(file));
    for (const name of ['router.log.02', 'router.log.2e0', 'router.log.0x10', 'router.log.5'])
      fs.writeFileSync(path.join(dir, 'logs', name), 'x');
    const log = createLog({ file, maxBytes: ENTRY, maxFiles: 1, now });
    log('line1');
    log('line2');
    assert.deepEqual(names(), ['router.log', 'router.log.02', 'router.log.0x10', 'router.log.1', 'router.log.2e0']);
  });

  it('matches older files regardless of case when ignoreCase is set', () => {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(path.join(dir, 'logs', 'ROUTER.LOG.7'), 'x');
    const log = createLog({ file, maxBytes: ENTRY, maxFiles: 1, now, ignoreCase: true });
    log('line1');
    log('line2');
    assert.deepEqual(names(), ['router.log', 'router.log.1']);
  });

  it('measures lines in bytes, not characters', () => {
    // 'é' is 27 characters with its timestamp but 28 bytes, so the file would hold 58 characters but 59 bytes.
    const log = createLog({ file, maxBytes: 58, maxFiles: 1, now });
    log('line1');
    log('é');
    assert.deepEqual(names(), ['router.log', 'router.log.1']);
  });
});
