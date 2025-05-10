import { Redis } from 'ioredis';
import { PassThrough, Readable, Stream, Writable } from 'stream';

class Backup {
  private chunks: Buffer[] = [];

  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private writable: Writable,
  ) {}

  private async backup() {
    let cursor = '0';
    let keys: string[];

    this.writable.write(Buffer.from('version:1'));
    this.writable.write(Buffer.from('\n\n\n'));

    try {
      do {
        if (this.writable.closed) {
          return;
        }

        [cursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          `${this.prefix}:*`,
        );

        for (const key of keys) {
          // todo: remove prefix
          if (this.writable.closed) {
            return;
          }

          const bufKey = Buffer.from(key.slice(this.prefix.length + 1));
          const dumped = await this.redis.dumpBuffer(key);
          const entryHeader = Buffer.alloc(8);

          entryHeader.writeUInt32BE(bufKey.length, 0);
          entryHeader.writeUInt32BE(dumped.length, 4);

          this.writable.write(
            Buffer.concat([Buffer.from(entryHeader), bufKey, dumped]),
          );
        }
      } while (cursor !== '0');
    } catch (error) {
      this.writable.destroy(error as Error);

      return;
    }

    this.writable.end();
  }

  async run() {
    process.nextTick(this.backup.bind(this));
  }
}

export async function backup(params: {
  redis: Redis;
  prefix: string;
}): Promise<Readable> {
  const { redis, prefix } = params;

  const pt = new PassThrough();

  const exported = new Backup(redis, prefix, pt);

  await exported.run();

  return pt;
}

export async function restore(params: {
  redis: Redis;
  prefix: string;
  backup: Stream | Buffer;
}) {
  const { redis, prefix, backup } = params;

  const buffer = Buffer.isBuffer(backup)
    ? backup
    : await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];

        backup.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        backup.on('end', () => {
          resolve(Buffer.concat(chunks));
        });

        backup.on('error', reject);
      });

  // console.log('buffer', buffer.toString());

  let header: number[] = [];

  let i = 0;

  // read header
  while (i < buffer.length) {
    header.push(buffer.readUInt8(i));
    i++;

    if (
      header.length >= 3 &&
      header[header.length - 1] === 10 &&
      header[header.length - 2] === 10 &&
      header[header.length - 3] === 10
    ) {
      break;
    }
  }

  let key: number[] = [];
  let value: number[] = [];

  while (i < buffer.length) {
    const keyLen = buffer.readUInt32BE(i);
    const dumpLen = buffer.readUint32BE(i + 4);
    // console.log('keyLen', keyLen, 'dumpLen', dumpLen);

    i += 8;

    for (let j = 0; j < keyLen; j++) {
      key.push(buffer.readUInt8(i));
      i++;
    }

    const keyStr = `${prefix}:${Buffer.from(key).toString()}`;

    key = [];

    for (let j = 0; j < dumpLen; j++) {
      value.push(buffer.readUInt8(i));
      i++;
    }

    await redis.restore(keyStr, 0, Buffer.from(value));

    value = [];
  }
}
