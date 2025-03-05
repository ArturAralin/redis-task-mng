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

  function buildKibanaUrl(params: {
    from: number;
    to: number | null;
    query: string,
  }) {
    const from = `'${new Date(params.from).toISOString()}'`;
    const to = params.to ? `'${new Date(params.to).toISOString()}'` : 'now';

    const parts = [
      'https://logs.devtaxis.uk/app/discover#/',
      `?_g=(time:(from:${from},to:${to}))`,
      `&_a=(query:(language:kuery,query:'${params.query}'),sort:!(!('@timestamp',desc)))`,
    ];

    return parts.join('');
  }

  app.use(expressUiServer({
    redis,
    client,
    tasksSection: {
      proceduralColumns: [
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

            const autoParkId = 'a-b-c';

            return {
              type: 'url',
              text: 'kib',
              url: buildKibanaUrl({
                from: task.addedAt,
                to: null,
                query: `serviceName:"worker" and moduleName:"calculate-routes-subscriber" and (meta.data.autoParkId:"${autoParkId}" or meta.autoParkId:"${autoParkId}")`,
              })
            }
          }
        }
      ]
    },
  }))

  app.listen(8817);
}

main();
