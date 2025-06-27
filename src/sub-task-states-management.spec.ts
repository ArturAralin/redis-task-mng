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


  test('complete one subtask', async () => {
    const taskId: string = uuid.v4();

    await tracker.createTask(taskId, {
      name: 'Long task',
      subtasks: [
        {
          subTaskId: 't1',
        },
        {
          subTaskId: 't2',
        },
        {
          subTaskId: 't3',
        },
      ],
    });

    await tracker.startSubTask(taskId, 't1', {
      metadata: {
        'Here is': 'start',
      },
    });

    await new Promise((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, 10);
    });

    await tracker.failSubTask(taskId, 't1', {
      metadata: {
        'Here is': 'fail',
      },
    });

    const taskStateAfterFail = await tracker.getTaskState(taskId);

    expect(taskStateAfterFail).toMatchObject({
      taskId,
      addedAt: expect.any(Number),
      completeAt: null,
      subtasksCount: 3,
      subtasksRemaining: 3,
      subtasksFailed: 1,
      complete: false,
      name: 'Long task',
      metadata: null,
    });

    await new Promise((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, 10);
    });

    await tracker.startSubTask(taskId, 't1');

    await new Promise((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, 10);
    });

    await tracker.completeSubTask(taskId, 't1', {
      metadata: {
        'Here is': 'complete',
      },
    });

    const taskState = await tracker.getTaskState(taskId);

    expect(taskState).toMatchObject({
      taskId,
      addedAt: expect.any(Number),
      subtasksCount: 3,
      subtasksRemaining: 2,
      complete: false,
    });

    const points = await tracker.getSubTaskPoints(taskId, 't1');

    expect(points[0]).toMatchObject({
      subTaskId: 't1',
      event: SubTaskEvents.InProgress,
      timestamp: expect.any(Number),
      metadata: {
        'Here is': 'start',
      },
    });

    expect(points[1]).toMatchObject({
      subTaskId: 't1',
      event: SubTaskEvents.Failed,
      timestamp: expect.any(Number),
      metadata: {
        'Here is': 'fail',
      },
    });

    expect(points[2]).toMatchObject({
      subTaskId: 't1',
      event: SubTaskEvents.InProgress,
      timestamp: expect.any(Number),
      metadata: null,
    });

    expect(points[3]).toMatchObject({
      subTaskId: 't1',
      event: SubTaskEvents.Complete,
      timestamp: expect.any(Number),
      metadata: {
        'Here is': 'complete',
      },
    });
  });

  test('get sub tasks should fail if no task exists', async () => {
    await tracker.getSubTasks('non-existing-task-id');
  });

  test('set sub tasks in progress should fail if no task exists', async () => {
    const fn = async () => {
      await tracker.startSubTask('non-existing-task-id', 'non-existing-subtask-id');
    };


    expect(fn).rejects.toThrow('Error in startSubTask: Sub task "non-existing-subtask-id" in task "non-existing-task-id" not found');
  });

  test('failing sub tasks should fail if no task exists', async () => {
    const fn = async () => {
      await tracker.failSubTask('non-existing-task-id', 'non-existing-subtask-id');
    };


    expect(fn).rejects.toThrow('Error in failSubTask: Sub task "non-existing-subtask-id" in task "non-existing-task-id" not found');
  });

  test('complete sub tasks should fail if no task exists', async () => {
    const fn = async () => {
      await tracker.completeSubTask('non-existing-task-id', 'non-existing-subtask-id');
    };


    expect(fn).rejects.toThrow('Error in completeSubTask: Sub task "non-existing-subtask-id" in task "non-existing-task-id" not found');
  });

  test('checking completeness of non existing sub tasks should fail', async () => {
    const fn = async () => {
      await tracker.isSubTaskComplete('non-existing-task-id', 'non-existing-subtask-id');
    };


    expect(fn).rejects.toThrow('Error in isSubTaskComplete: Task "non-existing-task-id" not found');
  });
});
