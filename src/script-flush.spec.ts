import * as uuid from 'uuid';
import Redis from 'ioredis';
import { SubTaskEvents, SubTaskStates, TaskTracker } from './tracker';

describe('TaskTracker', () => {
  let redis: Redis;
  let tracker: TaskTracker;

  beforeAll(async () => {
    redis = new Redis({
      port: process.env.REDIS_PORT
        ? parseInt(process.env.REDIS_PORT, 10)
        : 6379,
    });

    tracker = new TaskTracker({
      redis,
    });

    await redis.ping();
    await tracker.waitReadiness();
  });

  afterAll(() => redis.disconnect());

  test('create task', async () => {
    const taskId: string = uuid.v4();
    await tracker.createTask(taskId, {
      subtasks: [
        {
          subTaskId: '123',
        },
      ],
    });

    await redis.script('FLUSH');

    await tracker.createTask(taskId, {
      subtasks: [
        {
          subTaskId: '123',
        },
      ],
    });
  });
});
