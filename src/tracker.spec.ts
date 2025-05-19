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

    const { seqId } = await tracker.createTask(taskId, {
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

    const taskState = await tracker.getTaskState(taskId);

    expect(taskState).toMatchObject({
      taskId: taskId,
      seqId,
      addedAt: expect.any(Number),
      subtasksCount: 3,
      subtasksRemaining: 3,
      complete: false,
    });
  });

  test('create multiple tasks with same task id', async () => {
    const taskId: string = uuid.v4();

    const concurrentCreation = await Promise.all([
      tracker.createTask(taskId, {
        subtasks: [
          {
            subTaskId: 't1',
          },
        ],
      }),
      tracker.createTask(taskId, {
        subtasks: [
          {
            subTaskId: 't1',
          },
        ],
      }),
      tracker.createTask(taskId, {
        subtasks: [
          {
            subTaskId: 't1',
          },
        ],
      }),
    ]);

    const postCreation = await tracker.createTask(taskId, {
      subtasks: [
        {
          subTaskId: 't1',
        },
      ],
    });

    const createdTasks = concurrentCreation.filter((t) => t.created);
    const notCreatedTasks = concurrentCreation.filter((t) => !t.created);
    const uniqSeqIds = new Set([
      postCreation.seqId,
      ...concurrentCreation.map((t) => t.seqId),
    ]);

    expect(createdTasks.length).toBe(1);
    expect(notCreatedTasks.length).toBe(2);
    expect(uniqSeqIds.size).toBe(4);
    expect(postCreation.created).toBe(false);
  });

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
          subTaskId: 't3',
        },
      ],
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
    });
  });

  test('get sub tasks state', async () => {
    const taskId: string = uuid.v4();

    await tracker.createTask(taskId, {
      name: 'Sub tasks state',
      timezone: 'Europe/Moscow',
      subtasks: [
        {
          subTaskId: 't1',
          name: 'Sub task name',
        },
        {
          subTaskId: 't2',
          metadata: {
            foo: 'bar',
            bool: false,
            num: -1,
          },
        },
        {
          subTaskId: 't3',
        },
        {
          subTaskId: 't4',
        },
      ],
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
      taskId,
      addedAt: expect.any(Number),
      completeAt: null,
      subtasksCount: 4,
      subtasksRemaining: 3,
      complete: false,
      name: 'Sub tasks state',
      timezone: 'Europe/Moscow',
    });

    const subTasks = await tracker.getSubTasks(taskId);

    expect(subTasks[0]).toMatchObject({
      subTaskId: 't1',
      attempts: 1,
      state: SubTaskStates.Complete,
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
      failedAt: null,
      name: 'Sub task name',
    });

    expect(subTasks[1]).toMatchObject({
      subTaskId: 't2',
      state: SubTaskStates.InProgress,
      startedAt: expect.any(Number),
      completedAt: null,
      failedAt: null,
      attempts: 1,
      metadata: {
        foo: 'bar',
        bool: false,
        num: -1,
      },
    });

    expect(subTasks[2]).toMatchObject({
      subTaskId: 't3',
      state: SubTaskStates.Failed,
      startedAt: expect.any(Number),
      completedAt: null,
      failedAt: expect.any(Number),
      attempts: 2,
    });

    expect(subTasks[3]).toMatchObject({
      subTaskId: 't4',
      state: SubTaskStates.Waiting,
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
          subTaskId: 't3',
        },
      ],
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

    const recordsWithTaskCompleteFlag = res.filter((r) => r.allTasksCompleted);

    expect(recordsWithTaskCompleteFlag.length).toBe(1);

    const subTasks = await tracker.getSubTasks(taskId);
    const sortedSubTasks = subTasks.sort((a, b) =>
      a.subTaskId.localeCompare(b.subTaskId),
    );

    expect(sortedSubTasks[0]).toMatchObject({
      subTaskId: 't1',
      state: SubTaskStates.Complete,
      attempts: 1,
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
      failedAt: null,
    });

    expect(sortedSubTasks[1]).toMatchObject({
      subTaskId: 't2',
      state: SubTaskStates.Complete,
      attempts: 1,
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
      failedAt: null,
    });

    expect(sortedSubTasks[2]).toMatchObject({
      subTaskId: 't3',
      state: SubTaskStates.Complete,
      attempts: 1,
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
      failedAt: null,
    });

    const taskState = await tracker.getTaskState(taskId);

    expect(taskState).toMatchObject({
      taskId,
      addedAt: expect.any(Number),
      completeAt: expect.any(Number),
      subtasksCount: 3,
      subtasksRemaining: 0,
      complete: true,
    });
  });

  test('should task with metadata', async () => {
    const taskId: string = uuid.v4();

    await tracker.createTask(taskId, {
      metadata: {
        boolField: false,
        stringField: 'string',
        numberField: -20,
      },
      subtasks: [{ subTaskId: 'stId' }],
    });

    const taskState = await tracker.getTaskState(taskId);

    expect(taskState).toMatchObject({
      taskId,
      metadata: {
        boolField: false,
        stringField: 'string',
        numberField: -20,
      },
    });
  });

  test('complete non existing subtask', async () => {
    await tracker.completeSubTask('taskId', 'subTaskId');
    await tracker.failSubTask('taskId', 'subTaskId');
    await tracker.startSubTask('taskId', 'subTaskId');
    await tracker.isSubTaskComplete('taskId', 'subTaskId');
  });
});
