import { expressUiServer, TaskTracker } from './src/lib';
import { Redis } from 'ioredis';
import express from 'express';

async function main() {
  const redis = new Redis();
  const client = new TaskTracker({
    redis,
  });

  await redis.ping();
  await client.waitReadiness();

  const app = express();

  app.use(expressUiServer({
    redis,
    client,
    metadataSettings: {
      tasksMetadataColumns: [
        {
          key: 'boolField',
        },
        {
          key: 'stringField',
          mapper(value) {
            return {
              type: 'url',
              url: `https://google.com/search?q=${value}`,
              linkText: `Google search for "${value}"`,
            }
          }
        },
        {
          key: 'numberField',
        },
      ]
    }
  }))

  app.listen(8817);
}

main();
