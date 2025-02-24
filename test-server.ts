import { expressUiServer, TaskTracker } from './src/lib';
import { Redis } from 'ioredis';

async function main() {
  const redis = new Redis();
  const client = new TaskTracker({
    redis,
  });

  await redis.ping();
  await client.waitReadiness();

  expressUiServer({
    redis,
    client,
  }).listen(8817, () => {
    console.log('server started');
  });
}

main();
