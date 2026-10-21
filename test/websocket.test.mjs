import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { messageFilter } from '../src/websocket.mjs';

/** An unmasked server-to-client WebSocket frame. */
export function frame(opcode, payload, { fin = true, rsv = 0 } = {}) {
  const data = Buffer.from(payload);
  let header;
  if (data.length < 126)
    header = Buffer.from([0, data.length]);
  else if (data.length < 65536)
    header = Buffer.from([0, 126, data.length >> 8, data.length & 0xff]);
  else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | rsv | opcode;
  return Buffer.concat([header, data]);
}

const dropLimits = text => JSON.parse(text).type === 'codex.rate_limits';

/** Writes each buffer to the filter and returns what it emitted, or the error it raised. */
function run(writes, drop = dropLimits) {
  return new Promise(resolve => {
    const filter = messageFilter(drop);
    const out = [];
    filter.on('data', d => out.push(d));
    filter.on('error', error => resolve({ error, out: Buffer.concat(out) }));
    filter.on('end', () => resolve({ out: Buffer.concat(out) }));
    for (const w of writes)
      filter.write(w);
    filter.end();
  });
}

describe('messageFilter', () => {
  it('passes a 64-bit-length frame split across many writes unchanged', async () => {
    const big = frame(0x1, JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(70_000) }));
    const writes = [];
    for (let i = 0; i < big.length; i += 97)
      writes.push(big.subarray(i, i + 97));
    const { out, error } = await run(writes);
    assert.equal(error, undefined);
    assert.deepEqual(out, big);
  });

  it('drops a matching message whose type is written with JSON escapes', async () => {
    const { out } = await run([frame(0x1, '{"t\\u0079pe":"codex.rate_\\u006cimits"}'), frame(0x1, '{"type":"ok"}')]);
    assert.deepEqual(out, frame(0x1, '{"type":"ok"}'));
  });

  it('passes binary frames before their message finishes', async () => {
    const first = frame(0x2, Buffer.from([1]), { fin: false });
    const filter = messageFilter(dropLimits);
    const emitted = new Promise(resolve => filter.once('data', resolve));
    filter.write(first);
    assert.deepEqual(await emitted, first);
  });

  it('discards a pending message and later data frames after a close frame', async () => {
    const close = frame(0x8, Buffer.from([0x03, 0xe8]));
    const { out } = await run([frame(0x1, '{"type":', { fin: false }), close, frame(0x0, '"ok"}'), frame(0x1, '{"type":"ok"}')]);
    assert.deepEqual(out, close);
  });

  it('fails on a frame with RSV bits set', async () => {
    const { error } = await run([frame(0x1, '{}', { rsv: 0x40 })]);
    assert.match(error.message, /RSV/);
  });

  it('fails on a masked server frame', async () => {
    const masked = frame(0x1, '{}');
    masked[1] |= 0x80;
    const { error } = await run([masked]);
    assert.match(error.message, /masked/);
  });

  it('fails on a frame longer than the limit without waiting for its payload', async () => {
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(1n << 40n, 2);
    const { error } = await run([header]);
    assert.match(error.message, /exceeded/);
  });

  it('fails on a text message that grows past the limit', async () => {
    const part = Buffer.alloc(32 * 1024 * 1024, 0x61);
    const { error } = await run([frame(0x1, part, { fin: false }), frame(0x0, part, { fin: false }), frame(0x0, 'x')]);
    assert.match(error.message, /exceeded/);
  });

  it('fails on a text message with too many fragments, even empty ones', async () => {
    const writes = [frame(0x1, '', { fin: false })];
    for (let i = 0; i < 5000; i++)
      writes.push(frame(0x0, '', { fin: false }));
    const { error } = await run(writes);
    assert.match(error.message, /fragments/);
  });

  it('fails on a continuation frame outside a message', async () => {
    const { error } = await run([frame(0x0, 'x')]);
    assert.match(error.message, /continuation/);
  });
});
