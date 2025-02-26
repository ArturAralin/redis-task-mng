import * as uuid from 'uuid';
import Redis from 'ioredis';
import { SubTaskEvents, SubTaskStates, TaskTracker } from './tracker';

describe('TaskTracker', () => {
  let redis: Redis;
  let tracker: TaskTracker;

  beforeAll(async () => {
    redis = new Redis();

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
      subtasks: [{
        subTaskId: '123',
      }]
    });

    await redis.script('FLUSH');

    await tracker.createTask(taskId, {
      subtasks: [{
        subTaskId: '123',
      }]
    });
  });
});
