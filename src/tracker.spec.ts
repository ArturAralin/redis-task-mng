import * as uuid from 'uuid'
import Redis from "ioredis";
import { ProgressStateEnum, TaskTracker } from './tracker';

describe('TaskTracker', () => {
  let redis: Redis;
  let tracker: TaskTracker;

  beforeAll(async () => {
    redis = new Redis();
    tracker = new TaskTracker(redis);

    await redis.ping();
    await tracker.init();
  });

  afterAll(() => redis.disconnect());

  test('create task', async () => {
    const taskId: string = uuid.v4();

    await tracker.createTask(taskId, {
      subtasks: [
        {
          subTaskId: 't1',
        },
        {
          subTaskId: 't2',
        },
        {
          subTaskId: 't3'
        }
      ]
    });

    const taskState = await tracker.getTaskState(taskId);

    expect(taskState).toMatchObject({
      id: taskId,
      addedAt: expect.any(Number),
      subtasksCount: 3,
      subtasksRemaining: 3,
      complete: false,
    })
  });


  test('complete one subtask', async () => {
    const taskId: string = uuid.v4();

    await tracker.createTask(taskId, {
      subtasks: [
        {
          subTaskId: 't1',
        },
        {
          subTaskId: 't2',
        },
        {
          subTaskId: 't3'
        }
      ]
    });

    await tracker.startSubTask(taskId, 't1');
    await tracker.completeSubTask(taskId, 't1');

    const taskState = await tracker.getTaskState(taskId);

    expect(taskState).toMatchObject({
      id: taskId,
      addedAt: expect.any(Number),
      subtasksCount: 3,
      subtasksRemaining: 2,
      complete: false,
    })
  });

  test.skip('double complete one task task', async () => {
    const taskId: string = uuid.v4();

    await tracker.createTask(taskId, {
      subtasks: [
        {
          subTaskId: 't1',
        },
        {
          subTaskId: 't2',
        },
        {
          subTaskId: 't3'
        }
      ]
    });

    await tracker.startSubTask(taskId, 't2');

    await tracker.completeSubTask(taskId, 't2');
    await tracker.completeSubTask(taskId, 't2');

    const taskState = await tracker.getTaskState(taskId);

    expect(taskState).toMatchObject({
      id: taskId,
      addedAt: expect.any(Number),
      subtasksCount: 3,
      subtasksRemaining: 2,
      complete: false,
    })
  });

  test('get sub tasks state', async () => {
    const taskId: string = uuid.v4();

    await tracker.createTask(taskId, {
      subtasks: [
        {
          subTaskId: 't1',
        },
        {
          subTaskId: 't2',
        },
        {
          subTaskId: 't3'
        },
        {
          subTaskId: 't4'
        },
      ]
    });

    await Promise.all([
      tracker.startSubTask(taskId, 't1'),
      tracker.startSubTask(taskId, 't2'),
      tracker.startSubTask(taskId, 't3'),
      tracker.startSubTask(taskId, 't3'),
      tracker.startSubTask(taskId, 't3'),
    ]);

    await tracker.completeSubTask(taskId, 't1');

    await tracker.failSubTask(taskId, 't3');
    await tracker.startSubTask(taskId, 't3');
    await tracker.failSubTask(taskId, 't3');

    const taskState = await tracker.getTaskState(taskId);

    expect(taskState).toMatchObject({
      id: taskId,
      addedAt: expect.any(Number),
      subtasksCount: 4,
      subtasksRemaining: 3,
      complete: false,
      name: null,
    });

    const subTasks = await tracker.getSubTasks(taskId);

    expect(subTasks[0]).toMatchObject({
      subTaskId: 't1',
      attempts: 1,
      state: ProgressStateEnum.Complete,
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
      failedAt: null
    });

    expect(subTasks[1]).toMatchObject({
      subTaskId: 't2',
      state: ProgressStateEnum.InProgress,
      startedAt: expect.any(Number),
      completedAt: null,
      failedAt: null,
      attempts: 1,
    });

    expect(subTasks[2]).toMatchObject({
      subTaskId: 't3',
      state: ProgressStateEnum.Failed,
      startedAt: expect.any(Number),
      completedAt: null,
      failedAt: expect.any(Number),
      attempts: 2,
    });

    expect(subTasks[3]).toMatchObject({
      subTaskId: 't4',
      state: ProgressStateEnum.New,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      attempts: 0,
    });
  });

  test('complete all subtasks', async () => {
    const taskId: string = uuid.v4();

    await tracker.createTask(taskId, {
      name: `complete all subtasks ${new Date()}`,
      subtasks: [
        {
          subTaskId: 't1',
        },
        {
          subTaskId: 't2',
        },
        {
          subTaskId: 't3'
        },
      ]
    });

    await tracker.startSubTask(taskId, 't1');

    const t1Complete1 = await tracker.isSubTaskComplete(taskId, 't1');
    expect(t1Complete1).toBe(false);

    await tracker.completeSubTask(taskId, 't1');

    const t1Complete2 = await tracker.isSubTaskComplete(taskId, 't1');
    expect(t1Complete2).toBe(true);

    await Promise.all([
      tracker.startSubTask(taskId, 't2'),
      tracker.startSubTask(taskId, 't3'),
    ]);

    const res = await Promise.all([
      tracker.completeSubTask(taskId, 't2'),
      tracker.completeSubTask(taskId, 't3'),
    ]);

    const recordsWithTaskCompleteFlag = res.filter(r => r.allTasksCompleted);

    expect(recordsWithTaskCompleteFlag.length).toBe(1);

    const subTasks = await tracker.getSubTasks(taskId);
    const sortedSubTasks = subTasks.sort((a, b) => a.subTaskId.localeCompare(b.subTaskId));

    expect(sortedSubTasks[0]).toMatchObject({
      subTaskId: 't1',
      state: ProgressStateEnum.Complete,
      attempts: 1,
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
      failedAt: null
    });

    expect(sortedSubTasks[1]).toMatchObject({
      subTaskId: 't2',
      state: ProgressStateEnum.Complete,
      attempts: 1,
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
      failedAt: null
    });

    expect(sortedSubTasks[2]).toMatchObject({
      subTaskId: 't3',
      state: ProgressStateEnum.Complete,
      attempts: 1,
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
      failedAt: null
    });

    const taskState = await tracker.getTaskState(taskId);

    expect(taskState).toMatchObject({
      id: taskId,
      addedAt: expect.any(Number),
      subtasksCount: 3,
      subtasksRemaining: 0,
      complete: true,
    });
  })
});
