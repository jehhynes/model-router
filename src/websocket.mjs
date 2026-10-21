import { Transform } from 'node:stream';

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_FRAMES = 4096;

/** Drops whole text messages for which `drop(text)` is true from an uncompressed server-to-client WebSocket stream.
 * Other frames pass through byte for byte; text frames wait until their message is complete. */
export function messageFilter(drop) {
  const chunks = [];
  let buffered = 0;
  let text = null; // the text message being assembled: { frames, payloads, size }
  let inBinary = false;
  let closing = false;

  function take(n) {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = chunks[0];
      const used = Math.min(chunk.length, n - filled);
      chunk.copy(out, filled, 0, used);
      filled += used;
      if (used === chunk.length)
        chunks.shift();
      else
        chunks[0] = chunk.subarray(used);
    }
    buffered -= n;
    return out;
  }

  function peek(n) {
    return Buffer.concat(chunks, Math.min(n, buffered)).subarray(0, n);
  }

  return new Transform({
    transform(chunk, _encoding, callback) {
      chunks.push(chunk);
      buffered += chunk.length;
      try {
        for (;;) {
          const header = parseHeader(peek(10));
          if (!header || buffered < header.headerLength + header.payloadLength)
            break;
          const raw = take(header.headerLength + header.payloadLength);
          const payload = raw.subarray(header.headerLength);
          const { fin, opcode } = header;

          if (opcode >= 0x8) {
            if (opcode === 0x8) {
              closing = true;
              text = null;
            }
            this.push(raw);
            continue;
          }
          if (closing)
            continue;

          const starts = opcode !== 0x0;
          if (starts && (text || inBinary))
            throw new Error('a new message started before the previous one finished');
          if (!starts && !text && !inBinary)
            throw new Error('a continuation frame arrived outside a message');

          if (opcode === 0x2 || inBinary) {
            inBinary = !fin;
            this.push(raw);
            continue;
          }

          text ??= { frames: [], payloads: [], size: 0 };
          text.frames.push(raw);
          text.payloads.push(payload);
          text.size += raw.length;
          if (text.size > MAX_MESSAGE_BYTES)
            throw new Error(`a text message exceeded ${MAX_MESSAGE_BYTES} bytes`);
          if (text.frames.length > MAX_MESSAGE_FRAMES)
            throw new Error(`a text message exceeded ${MAX_MESSAGE_FRAMES} fragments`);
          if (!fin)
            continue;

          const done = text;
          text = null;
          if (!drop(Buffer.concat(done.payloads).toString('utf8')))
            for (const f of done.frames)
              this.push(f);
        }
      } catch (err) {
        return callback(err);
      }
      callback();
    },
  });
}

/** Parses a frame header; null when more bytes are needed. Rejects what an uncompressed server must not send. */
function parseHeader(buf) {
  if (buf.length < 2)
    return null;
  if (buf[0] & 0x70)
    throw new Error('a frame set RSV bits without a negotiated extension');
  if (buf[1] & 0x80)
    throw new Error('the server sent a masked frame');
  let payloadLength = buf[1] & 0x7f;
  let headerLength = 2;
  if (payloadLength === 126) {
    if (buf.length < 4)
      return null;
    payloadLength = buf.readUInt16BE(2);
    headerLength = 4;
  } else if (payloadLength === 127) {
    if (buf.length < 10)
      return null;
    const length = buf.readBigUInt64BE(2);
    if (length > BigInt(MAX_MESSAGE_BYTES))
      throw new Error(`a frame exceeded ${MAX_MESSAGE_BYTES} bytes`);
    payloadLength = Number(length);
    headerLength = 10;
  }
  return { fin: (buf[0] & 0x80) !== 0, opcode: buf[0] & 0x0f, headerLength, payloadLength };
}
