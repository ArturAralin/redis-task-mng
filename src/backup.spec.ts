import * as uuid from 'uuid';
import Redis from 'ioredis';
import { SubTaskEvents, SubTaskStates, TaskTracker } from './tracker';
import { backup, restore } from './backup';

describe('TaskTracker', () => {
  let redis: Redis;
  let tracker: TaskTracker;
  let backupPrefix = uuid.v4().slice(0, 5);
  let restorePrefix = uuid.v4().slice(0, 5);

  beforeAll(async () => {
    redis = new Redis({
      port: process.env.REDIS_PORT
        ? parseInt(process.env.REDIS_PORT, 10)
        : 6379,
    });

    tracker = new TaskTracker({
      redis,
      prefix: backupPrefix,
    });

    await redis.ping();
    await tracker.waitReadiness();

    await tracker.createTask(uuid.v4(), {
      metadata: {
        taskMeta: 'taskMeta',
      },
      subtasks: [
        {
          subTaskId: 't1',
          metadata: {
            meta1: 'meta1',
          },
        },
        {
          subTaskId: 't2',
          metadata: {
            meta2: 2,
          },
        },
        {
          subTaskId: 't3',
        },
      ],
    });
  });

  afterAll(() => redis.disconnect());

  test('Backup', async () => {
    const chunks: Buffer[] = [];
    const stream = await backup({
      redis,
      prefix: backupPrefix,
    });

    stream.on('data', (data) => {
      chunks.push(data);
    });

    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const backupFile = Buffer.concat(chunks);

    expect(backupFile.length).toBeGreaterThan(0);

    await restore({
      redis,
      prefix: restorePrefix,
      backup: backupFile,
    });

    const tracker2 = new TaskTracker({
      redis,
      prefix: restorePrefix,
    });

    await tracker2.waitReadiness();

    // const r = await tracker2.getTasks();

    // const subtasks = await tracker2.getSubTasks(r[0].taskId);

    // console.log('r', r);
    // console.log('subtasks', subtasks);
  });
});
