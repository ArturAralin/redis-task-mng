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
          name: 'Procedural column text',
          mapper(task) {
            return {
              type: 'text',
              text: `I'm procedural column for task ${task.name}`,
            }
          }
        },
        {
          name: 'Procedural column link',
          mapper(task) {
            if (task.metadata?.stringField) {
              return {
                type: 'url',
                text: `I'm a link`,
                url: `https://google.com?q=${task.metadata?.stringField}`
              }
            }

            return null
          }
        }
      ]
    }
  }))

  app.listen(8817);
}

main();
