import type { Redis } from 'ioredis';

export enum ProgressStateEnum {
  Failed = -1,
  New = 0,
  InProgress = 1,
  Complete = 2,
}

interface TaskDbState {
  id: string;
  addedAt: number;
  completeAt?: number;
  subtasksCount: number;
  name?: string;
  metadata?: Metadata;
  v: 1;
}

type Metadata = Record<string, string | number | boolean>;

export interface CreateSubTask {
  subTaskId: string;
}

export interface SubTaskState {
  subTaskId: string;
  state: ProgressStateEnum;
  attempts: number;
  startedAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
}

export interface TaskState {
  id: string;
  name: string | null;
  addedAt: number;
  completeAt: number | null;
  subtasksCount: number;
  subtasksRemaining: number;
  metadata: Metadata | null;
  complete: boolean;
}

const KEY_SEPARATOR = '##!';

function dateToNumber(date: Date | number): number {
  if (date instanceof Date) {
    return date.getTime();
  }

  return date;
}

function mapTaskState(dbState: TaskDbState, remainingTasks: number): TaskState {
  return {
    id: dbState.id,
    addedAt: dbState.addedAt,
    completeAt: dbState.completeAt || null,
    subtasksCount: dbState.subtasksCount,
    subtasksRemaining: remainingTasks,
    complete: remainingTasks === 0,
    name: dbState.name || null,
    metadata: dbState.metadata || null,
  };
}

export class TaskTracker {
  private prefix: string;

  private tasksStateKey: string;

  private tasksRegisterKey: string;

  private subTasksStateKey: string;

  private subTasksRegisterPrefix: string;

  private createTaskLua: string | null = null;

  private completeSubTaskLua: string | null = null;

  private subTaskInProgressLua: string | null = null;

  private subTaskFailedLua: string | null = null;


  constructor(
    private readonly redis: Redis,
  ) {
    this.prefix = 'tm';
    this.tasksStateKey = `${this.prefix}:tasks`;
    this.tasksRegisterKey = `${this.prefix}:register`;
    this.subTasksStateKey = `${this.prefix}:subtasks`;
    this.subTasksRegisterPrefix = `${this.prefix}:subtasks_register`;
  }

  async init() {
    const luaCreateTask = `
      local task_id = KEYS[1]
      local added_at = KEYS[2]
      local state = KEYS[3]
      redis.call('ZADD', '${this.tasksRegisterKey}', added_at, task_id)
      redis.call('HSET', '${this.tasksStateKey}', task_id, state)

      redis.call('SADD', '${this.subTasksRegisterPrefix}:' .. task_id, unpack(ARGV))
      for _, st_id in ipairs(ARGV) do
        redis.call('HSET', '${this.subTasksStateKey}:' .. task_id, st_id .. '${KEY_SEPARATOR}state', ${ProgressStateEnum.New})
      end
    `;

    const luaCompleteSubTask = `
      local task_id = KEYS[1]
      local subtask_id = KEYS[2]
      local completed_at = tonumber(KEYS[3])

      local current_state = redis.call('HGET', '${this.subTasksStateKey}:' .. task_id, subtask_id .. '${KEY_SEPARATOR}state')

      -- use > or <
      if current_state ~= '${ProgressStateEnum.InProgress}' then
        error('Subtask is not in progress')
      end

      redis.call('HSET', '${this.subTasksStateKey}:' .. task_id, subtask_id .. '${KEY_SEPARATOR}state', ${ProgressStateEnum.Complete})
      redis.call('HSET', '${this.subTasksStateKey}:' .. task_id, subtask_id .. '${KEY_SEPARATOR}finished_at', completed_at)
      redis.call('SREM', '${this.subTasksRegisterPrefix}:' .. task_id, subtask_id)

      local remaining_tasks = redis.call('SCARD', '${this.subTasksRegisterPrefix}:' .. task_id)

      if remaining_tasks == 0 then
        local task_json_state = redis.call('HGET', '${this.tasksStateKey}', task_id)
        local task_state = cjson.decode(task_json_state)
        task_state['completeAt'] = completed_at

        redis.call('HSET', '${this.tasksStateKey}', task_id, cjson.encode(task_state))
      end

      return remaining_tasks
    `;


    const luaSubTaskInProgress = `
      local task_id = KEYS[1]
      local subtask_id = KEYS[2]
      local started_at = KEYS[3]

      local current_state = redis.call('HGET', '${this.subTasksStateKey}:' .. task_id, subtask_id .. '${KEY_SEPARATOR}state')

      if current_state == '${ProgressStateEnum.New}' or current_state == '${ProgressStateEnum.Failed}' then
        redis.call('HINCRBY', '${this.subTasksStateKey}:' .. task_id, subtask_id .. '${KEY_SEPARATOR}attempts', 1)
      end

      redis.call('HSET', '${this.subTasksStateKey}:' .. task_id, subtask_id .. '${KEY_SEPARATOR}state', ${ProgressStateEnum.InProgress})
      redis.call('HSET', '${this.subTasksStateKey}:' .. task_id, subtask_id .. '${KEY_SEPARATOR}started_at', started_at)
    `;

    const luaSubTaskFailed = `
      local task_id = KEYS[1]
      local subtask_id = KEYS[2]
      local failed_at = KEYS[3]

      local current_state = redis.call('HGET', '${this.subTasksStateKey}:' .. task_id, subtask_id .. '${KEY_SEPARATOR}state')

      -- use > or <
      if current_state ~= '${ProgressStateEnum.InProgress}' then
        error('Subtask is not in progress')
      end

      redis.call('HSET', '${this.subTasksStateKey}:' .. task_id, subtask_id .. '${KEY_SEPARATOR}state', ${ProgressStateEnum.Failed})
      redis.call('HSET', '${this.subTasksStateKey}:' .. task_id, subtask_id .. '${KEY_SEPARATOR}failed_at', failed_at)
    `;

    this.createTaskLua = await this.redis.script('LOAD', luaCreateTask) as string;
    this.completeSubTaskLua = await this.redis.script('LOAD', luaCompleteSubTask) as string;
    this.subTaskInProgressLua = await this.redis.script('LOAD', luaSubTaskInProgress) as string;
    this.subTaskFailedLua = await this.redis.script('LOAD', luaSubTaskFailed) as string;
  }

  async createTask(taskId: string, params: {
    name?: string;
    metadata?: Metadata;
    subtasks: CreateSubTask[];
  }): Promise<void> {
    if (params.subtasks.length === 0) {
      throw new Error('No subtasks');
    }

    if (!this.createTaskLua) {
      throw new Error('TaskTracker not initialized');
    }

    const existingTask = await this.redis.exists(`${this.tasksStateKey}:${taskId}`);

    if (existingTask) {
      throw new Error(`Task with id ${taskId} already exists`);
    }

    const taskState: TaskDbState = {
      id: taskId,
      addedAt: Date.now(),
      subtasksCount: params.subtasks.length,
      name: params.name,
      metadata: params.metadata,
      v: 1,
    };

    const subtasksIds: string[] =  params.subtasks.map((subtask) => subtask.subTaskId);

    await this.redis.evalsha(
      this.createTaskLua,
      3,
      taskId,
      Date.now(),
      JSON.stringify(taskState),
      ...subtasksIds,
    );
  }

  async getTasks(params: {
    range?: {
      from: Date | number;
      to: Date | number;
    };
    taskIds?: string[];
  } = {}): Promise<TaskState[]> {
    const range = params.range || {
      from: 0,
      to: Date.now(),
    };

    const taskIds = params.taskIds || await this.redis.zrevrange(
      this.tasksRegisterKey,
      dateToNumber(range.from),
      dateToNumber(range.to),
    );

    if (taskIds.length === 0) {
      return [];
    }

    const uniqTaskIds = Array.from(new Set(taskIds));
    const rems = Promise.all(uniqTaskIds.map((taskId) => this.redis.scard(`${this.subTasksRegisterPrefix}:${taskId}`)));

    const [
      tasks,
      subTasksRemainingJobs,
    ] = await Promise.all([
      this.redis.hmget(
        this.tasksStateKey,
        ...uniqTaskIds
      ),
      rems
    ])

    const taskStates: TaskState[] = [];

    tasks.forEach((taskState, idx) => {
      if (!taskState) {
        // todo: add debug message
        return;
      }

      const state = JSON.parse(taskState) as TaskDbState;

      taskStates.push(mapTaskState(
        state,
        subTasksRemainingJobs[idx],
      ))

      taskStates.push(mapTaskState(
        state,
        subTasksRemainingJobs[idx],
      ));
    })

    return taskStates;
  }

  async getTaskState(taskId: string): Promise<TaskState | null> {
    const tasks = await this.getTasks({ taskIds: [taskId] });

    return tasks[0] || null;
  }


  async getSubTasks(taskId: string): Promise<SubTaskState[]> {
    const subtasks = await this.redis.hgetall(`${this.subTasksStateKey}:${taskId}`);

    const states = new Map<string, SubTaskState>();

    Object.entries(subtasks).forEach(([redisKey, value]) => {
      const idx = redisKey.indexOf(KEY_SEPARATOR);

      if (idx === -1) {
        throw new Error(`Invalid key "${redisKey}"`);
      }

      const subtaskId = redisKey.slice(0, idx);
      const key = redisKey.slice(idx + 3);

      const state = states.get(subtaskId) || {
        subTaskId: subtaskId,
        state: ProgressStateEnum.New,
        attempts: -1,
        startedAt: null,
        completedAt: null,
        failedAt: null,
      };

      // trick to prevent multiple Map.set calls
      if (state.attempts === -1) {
        state.attempts = 0;
        states.set(subtaskId, state);
      }

      switch (key) {
        case 'state':
          state.state = parseInt(value, 10) as ProgressStateEnum;
          break;
        case 'started_at':
          state.startedAt = parseInt(value, 10);
          break;
        case 'finished_at':
          state.completedAt = parseInt(value, 10);
          break;
        case 'failed_at':
          state.failedAt = parseInt(value, 10);
          break;
        case 'attempts':
          state.attempts = parseInt(value, 10);
          break;
      }
    });

    return Array.from(states.values());
  }

  async completeSubTask(taskId: string, subTaskId: string): Promise<{ allTasksCompleted: boolean }> {
    if (!this.completeSubTaskLua) {
      throw new Error('TaskTracker not initialized');
    }

    const ts = new Date().getTime();

    const remainingTasks = await this.redis.evalsha(
      this.completeSubTaskLua,
      3,
      taskId,
      subTaskId,
      ts,
    );

    return {
      allTasksCompleted: remainingTasks === 0
    }
  }

  async startSubTask(taskId: string, subTaskId: string) {
    if (!this.subTaskInProgressLua) {
      throw new Error('TaskTracker not initialized');
    }

    const ts = new Date().getTime();

    await this.redis.evalsha(
      this.subTaskInProgressLua,
      3,
      taskId,
      subTaskId,
      ts,
    )
  }

  async failSubTask(taskId: string, subTaskId: string) {
    if (!this.subTaskFailedLua) {
      throw new Error('TaskTracker not initialized');
    }

    const ts = new Date().getTime();

    await this.redis.evalsha(
      this.subTaskFailedLua,
      3,
      taskId,
      subTaskId,
      ts,
    )
  }

  async isSubTaskComplete(taskId: string, subTaskId: string): Promise<boolean> {
    const has = await this.redis.sismember(
      `${this.subTasksRegisterPrefix}:${taskId}`,
      subTaskId
    );

    return !has;
  }
}
