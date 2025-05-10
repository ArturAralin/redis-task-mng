import { ReplyError, type Redis } from 'ioredis';

export enum SubTaskStates {
  Failed = -1,
  Waiting = 0,
  InProgress = 1,
  Complete = 2,
}

export enum SubTaskEvents {
  Failed = -1,
  Added = 0,
  InProgress = 1,
  Complete = 2,
  Checkpoint = 3,
}

interface TaskDbState {
  taskId: string;
  seqId: number;
  addedAt: number;
  completeAt?: number;
  subtasksCount: number;
  remainingSubTasks?: number;
  name?: string;
  metadata?: Metadata;
  failedSubTasks?: number;
  v: 1;
}

export type MetadataValue = string | number | boolean;
export type Metadata = Record<string, MetadataValue | undefined>;

export interface CreateSubTask {
  name?: string;
  subTaskId: string;
  metadata?: Metadata;
}

export interface SubTaskState {
  subTaskId: string;
  state: SubTaskStates;
  attempts: number;
  startedAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
  name: string | null;
  metadata: Metadata | null;
}

export interface TaskState {
  taskId: string;
  seqId: number;
  name: string | null;
  addedAt: number;
  completeAt: number | null;
  subtasksCount: number;
  subtasksRemaining: number;
  subtasksFailed: number;
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

interface SubTaskPointDbState {
  event: SubTaskEvents;
  timestamp: string;
  metadata?: string;
}

interface SubTaskPoint {
  subTaskId: string;
  event: SubTaskEvents;
  timestamp: number;
  metadata: Metadata | null;
}

function mapTaskState(dbState: TaskDbState, oldRemaining: number): TaskState {
  const subtasksRemaining =
    typeof dbState.remainingSubTasks === 'number'
      ? dbState.remainingSubTasks
      : oldRemaining;

  return {
    seqId: dbState.seqId,
    taskId: dbState.taskId,
    addedAt: dbState.addedAt,
    completeAt: dbState.completeAt || null,
    subtasksCount: dbState.subtasksCount,
    subtasksRemaining,
    subtasksFailed: dbState.failedSubTasks || 0,
    complete: subtasksRemaining === 0,
    name: dbState.name || null,
    metadata: dbState.metadata || null,
  };
}

interface TaskTrackerParams {
  redis: Redis;
  prefix?: string;
}

function filterSeqIds(seqIds: (string | null)[]): string[] {
  return seqIds.filter(Boolean) as string[];
}

function patchError(error: unknown, prefix: string): void {
  if (error instanceof Error) {
    error.message = `${prefix}: ${error.message}`;
  }
}

export class TaskTracker {
  private redis: Redis;

  private ready: Promise<void>;

  private prefix: string;

  private tasksStateKey: string;

  private tasksRegisterKey: string;

  private subTasksStateKey: string;

  private remainingSubTasksPrefix: string;

  private failedSubTasksPrefix: string;

  private tasksCounterKey: string;

  private tasksIndexKey: string;

  private subTaskPointPrefix: string;

  private createTaskLua: string | null = null;

  private completeSubTaskLua: string | null = null;

  private subTaskInProgressLua: string | null = null;

  private subTaskFailedLua: string | null = null;

  constructor(params: TaskTrackerParams) {
    this.redis = params.redis;
    this.prefix = params.prefix || 'tm';
    this.tasksStateKey = `${this.prefix}:tasks`;
    this.tasksRegisterKey = `${this.prefix}:register`;
    this.subTasksStateKey = `${this.prefix}:subtasks`;
    this.remainingSubTasksPrefix = `${this.prefix}:subtasks_register`;
    this.failedSubTasksPrefix = `${this.prefix}:subtasks_failed`;
    this.tasksCounterKey = `${this.prefix}:tasks_counter`;
    this.tasksIndexKey = `${this.prefix}:tasks_index`;
    this.subTaskPointPrefix = `${this.prefix}:subtask_points`;

    this.ready =
      this.redis.status === 'ready'
        ? this.init()
        : new Promise((resolve, reject) => {
          this.redis.once('ready', () => {
            this.init().then(resolve).catch(reject);
          });

          this.redis.once('error', (err) => {
            reject(err);
          });
        });
  }

  private async init(): Promise<void> {
    const luaStoreSubTaskPoint = `
      local function store_event(seq_id, subtask_id, timestamp, event, metadata)
        local key = '${this.subTaskPointPrefix}:' .. seq_id .. ':' .. subtask_id
        local record = {}
        record['timestamp'] = timestamp
        record['event'] = event

        if metadata then
          record['metadata'] = metadata
        end

        redis.call('ZADD', key, timestamp, cjson.encode(record))
      end

      local function update_task_state(seq_id, timestamp)
        local state = redis.call('HGET', '${this.tasksStateKey}', seq_id)

        if not state then
          return
        end

        state = cjson.decode(state)
        local remaining_sub_tasks = tonumber(redis.call('SCARD', '${this.remainingSubTasksPrefix}:' .. seq_id))
        local failed_sub_tasks = tonumber(redis.call('HLEN', '${this.failedSubTasksPrefix}:' .. seq_id))

        local has_changes = false

        if remaining_sub_tasks == 0 then
          has_changes = true
          state['completeAt'] = timestamp
        end

        if remaining_sub_tasks ~= state['remainingSubTasks'] then
          has_changes = true
          state['remainingSubTasks'] = remaining_sub_tasks
        end

        if failed_sub_tasks ~= state['failedSubTasks'] then
          has_changes = true
          state['failedSubTasks'] = failed_sub_tasks
        end

        if has_changes then
          redis.call('HSET', '${this.tasksStateKey}', seq_id, cjson.encode(state))
        end
      end
    `;

    const luaCreateTask = `
      local seq_id = KEYS[1]
      local task_id = KEYS[2]
      local added_at = tonumber(KEYS[3])
      local state = KEYS[4]

      local existing_task = redis.call('HGET', '${this.tasksIndexKey}', task_id)

      if existing_task then
        return -1
      end

      redis.call('ZADD', '${this.tasksRegisterKey}', added_at, seq_id)
      redis.call('HSET', '${this.tasksStateKey}', seq_id, state)
      redis.call('HSET', '${this.tasksIndexKey}', task_id, seq_id)

      redis.call('SADD', '${this.remainingSubTasksPrefix}:' .. seq_id, unpack(ARGV))

      for _, st_id in ipairs(ARGV) do
        redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, st_id .. '${KEY_SEPARATOR}state', ${SubTaskStates.Waiting})
      end

      return 1
    `;

    const luaCompleteSubTask = `
      ${luaStoreSubTaskPoint}

      local task_id = KEYS[1]
      local subtask_id = KEYS[2]
      local completed_at = tonumber(KEYS[3])
      local metadata = KEYS[4]

      local seq_id = redis.call('HGET', '${this.tasksIndexKey}', task_id)

      if not seq_id then
        return 't_not_found'
      end

      local current_state = redis.call('HGET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}state')

      -- use > or <
      if current_state ~= '${SubTaskStates.InProgress}' then
        error('Subtask is not in progress')
      end

      redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}state', ${SubTaskStates.Complete})
      redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}finished_at', completed_at)
      redis.call('SREM', '${this.remainingSubTasksPrefix}:' .. seq_id, subtask_id)
      redis.call('HDEL', '${this.failedSubTasksPrefix}:' .. seq_id, subtask_id)

      update_task_state(seq_id, completed_at)
      store_event(seq_id, subtask_id, completed_at, ${SubTaskEvents.Complete}, metadata)

      return redis.call('SCARD', '${this.remainingSubTasksPrefix}:' .. seq_id)
    `;

    const luaSubTaskInProgress = `
      ${luaStoreSubTaskPoint}

      local task_id = KEYS[1]
      local subtask_id = KEYS[2]
      local started_at = KEYS[3]
      local metadata = KEYS[4]
      local seq_id = redis.call('HGET', '${this.tasksIndexKey}', task_id)

      if not seq_id then
        return 't_not_found'
      end

      local current_state = redis.call('HGET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}state')

      if current_state == '${SubTaskStates.Waiting}' or current_state == '${SubTaskStates.Failed}' then
        redis.call('HINCRBY', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}attempts', 1)
      end

      redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}state', ${SubTaskStates.InProgress})
      redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}started_at', started_at)

      store_event(seq_id, subtask_id, started_at, ${SubTaskEvents.InProgress}, metadata)
    `;

    const luaSubTaskFailed = `
      ${luaStoreSubTaskPoint}

      local task_id = KEYS[1]
      local subtask_id = KEYS[2]
      local failed_at = KEYS[3]
      local metadata = KEYS[4]

      local seq_id = redis.call('HGET', '${this.tasksIndexKey}', task_id)

      if not seq_id then
        return 't_not_found'
      end

      local current_state = redis.call('HGET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}state')

      -- use > or <
      if current_state ~= '${SubTaskStates.InProgress}' then
        error('Subtask is not in progress')
      end

      redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}state', ${SubTaskStates.Failed})
      redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}failed_at', failed_at)
      redis.call('HSET', '${this.failedSubTasksPrefix}:' .. seq_id, subtask_id, 1)

      update_task_state(seq_id, failed_at)
      store_event(seq_id, subtask_id, failed_at, ${SubTaskEvents.Failed}, metadata)
    `;

    this.createTaskLua = (await this.redis.script(
      'LOAD',
      luaCreateTask,
    )) as string;
    this.completeSubTaskLua = (await this.redis.script(
      'LOAD',
      luaCompleteSubTask,
    )) as string;
    this.subTaskInProgressLua = (await this.redis.script(
      'LOAD',
      luaSubTaskInProgress,
    )) as string;
    this.subTaskFailedLua = (await this.redis.script(
      'LOAD',
      luaSubTaskFailed,
    )) as string;
  }

  private async redisEvalScript(
    sha: string | null,
    keysCount: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    if (!sha) {
      throw new Error('Client is not initialized');
    }

    try {
      return await this.redis.evalsha(sha, keysCount, ...args);
    } catch (error) {
      if (error instanceof ReplyError) {
        if ((error as Record<string, string>).message.startsWith('NOSCRIPT')) {
          // re init lib and retry
          await this.init();

          return await this.redis.evalsha(sha, keysCount, ...args);
        }
      }

      throw error;
    }
  }

  /**
   * Create a new task. Creation is idempotent by taskId key
   */
  async createTask(
    taskId: string,
    params: {
      name?: string;
      metadata?: Metadata;
      subtasks: CreateSubTask[];
    },
  ): Promise<{
    seqId: number;
    created: boolean;
  }> {
    // todo: validate sub task ids /a-z0-9_-/
    if (params.subtasks.length === 0) {
      throw new Error('No subtasks');
    }

    try {
      const seqId = await this.redis.incr(this.tasksCounterKey);

      const taskState: TaskDbState = {
        taskId,
        seqId,
        addedAt: Date.now(),
        subtasksCount: params.subtasks.length,
        remainingSubTasks: params.subtasks.length,
        name: params.name,
        metadata: params.metadata,
        v: 1,
      };

      const subtasksIds: string[] = [];
      const restSubtaskFields: (string | number)[] = [];

      params.subtasks.forEach((subtask) => {
        subtasksIds.push(subtask.subTaskId);

        if (subtask.name) {
          restSubtaskFields.push(`${subtask.subTaskId}${KEY_SEPARATOR}name`);
          restSubtaskFields.push(subtask.name);
        }

        if (subtask.metadata) {
          restSubtaskFields.push(
            `${subtask.subTaskId}${KEY_SEPARATOR}metadata`,
          );
          restSubtaskFields.push(JSON.stringify(subtask.metadata));
        }
      });

      const createTaskResult = await this.redisEvalScript(
        this.createTaskLua,
        4,
        seqId,
        taskId,
        Date.now(),
        JSON.stringify(taskState),
        ...subtasksIds,
      );

      // Add rest subtask fields
      if (restSubtaskFields.length > 0) {
        await this.redis.hmset(
          `${this.subTasksStateKey}:${seqId}`,
          ...restSubtaskFields,
        );
      }

      return {
        seqId,
        created: createTaskResult === 1,
      };
    } catch (error) {
      patchError(error, 'Error in createTask');

      throw error;
    }
  }

  async getTasks(
    params: {
      range?: {
        from: Date | number;
        to: Date | number;
      };
      seqIds?: string[];
      taskIds?: string[];
      keepCompleted?: boolean;
      keepFailed?: boolean;
      keepInProgress?: boolean;
      pagination?: {
        limit?: number;
        offset?: number;
      };
    } = {},
  ): Promise<TaskState[]> {
    try {
      const range = params.range || {
        from: 0,
        to: Number.MAX_SAFE_INTEGER,
      };

      let seqIds: string[];

      if (params.seqIds) {
        seqIds = params.seqIds;
      } else if (params.taskIds) {
        // todo: add debug message
        seqIds = filterSeqIds(
          await this.redis.hmget(this.tasksIndexKey, ...params.taskIds),
        );
      } else {
        seqIds = await this.redis.zrange(
          this.tasksRegisterKey,
          dateToNumber(range.to),
          dateToNumber(range.from),
          'BYSCORE',
          'REV',
          'LIMIT',
          params.pagination?.offset || 0,
          params.pagination?.limit || Number.MAX_SAFE_INTEGER,
        );
      }

      if (seqIds.length === 0) {
        return [];
      }

      const tasks = await this.redis.hmget(
        this.tasksStateKey,
        ...new Set(seqIds),
      );

      const result: TaskState[] = [];

      const keepAllStatuses = typeof params.keepCompleted === 'undefined'
        && typeof params.keepFailed === 'undefined'
        && typeof params.keepInProgress === 'undefined';

        console.log('keepAllStatuses', keepAllStatuses);

      for (const taskState of tasks) {
        if (!taskState) {
          // todo: add debug message
          continue;
        }

        const state = JSON.parse(taskState) as TaskDbState;

        // backward compatibility
        let oldRemaining = -1;

        if (state.remainingSubTasks === undefined) {
          oldRemaining = await this.redis.scard(
            `${this.remainingSubTasksPrefix}:${state.seqId}`,
          );
        }

        const mappedTask = mapTaskState(state, oldRemaining);

        if (
          keepAllStatuses
          || (params.keepCompleted && mappedTask.subtasksRemaining === 0)
          || (params.keepFailed && mappedTask.subtasksFailed > 0)
          || (
            params.keepInProgress
            && (
              !mappedTask.completeAt
              && !mappedTask.subtasksFailed
            )
          )
        ) {
          result.push(mappedTask);
        }
      }

      return result;
    } catch (error) {
      patchError(error, 'Error in getTasks');

      throw error;
    }
  }

  async getTaskState(taskId: string): Promise<TaskState | null> {
    try {
      const tasks = await this.getTasks({
        taskIds: [taskId],
      });

      return tasks[0] || null;
    } catch (error) {
      patchError(error, 'Error in getTaskState');

      throw error;
    }
  }

  async getSubTasks(
    taskId: string,
    params?: {
      subtaskIds?: string[];
    },
  ): Promise<SubTaskState[]> {
    try {
      const seqId = await this.redis.hget(this.tasksIndexKey, taskId);
      const subtasks = await this.redis.hgetall(
        `${this.subTasksStateKey}:${seqId}`,
      );

      const states = new Map<string, SubTaskState>();

      Object.entries(subtasks).forEach(([redisKey, value]) => {
        const separatorIdx = redisKey.indexOf(KEY_SEPARATOR);

        if (separatorIdx === -1) {
          throw new Error(`Invalid key "${redisKey}"`);
        }

        const subtaskId = redisKey.slice(0, separatorIdx);

        // can be optimized by using hmget instead of hgetall
        if (params?.subtaskIds && !params.subtaskIds.includes(subtaskId)) {
          return;
        }

        const key = redisKey.slice(separatorIdx + 3);

        const state = states.get(subtaskId) || {
          subTaskId: subtaskId,
          state: SubTaskStates.Waiting,
          attempts: -1,
          startedAt: null,
          completedAt: null,
          failedAt: null,
          name: null,
          metadata: null,
        };

        // trick to prevent multiple Map.set calls
        if (state.attempts === -1) {
          state.attempts = 0;
          states.set(subtaskId, state);
        }

        switch (key) {
          case 'state':
            state.state = parseInt(value, 10) as SubTaskStates;
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
          case 'name':
            state.name = value;
            break;
          case 'metadata':
            state.metadata = JSON.parse(value) as Metadata;
            break;
        }
      });

      return Array.from(states.values());
    } catch (error) {
      patchError(error, 'Error in getSubTasks');

      throw error;
    }
  }

  async completeSubTask(
    taskId: string,
    subTaskId: string,
    params?: {
      metadata?: Metadata;
    },
  ): Promise<{ allTasksCompleted: boolean }> {
    try {
      const ts = new Date().getTime();
      const metadata = params?.metadata
        ? JSON.stringify(params.metadata)
        : 'null';

      const remainingTasks = await this.redisEvalScript(
        this.completeSubTaskLua,
        4,
        taskId,
        subTaskId,
        ts,
        metadata,
      );

      return {
        allTasksCompleted: remainingTasks === 0,
      };
    } catch (error) {
      patchError(error, 'Error in completeSubTask');

      throw error;
    }
  }

  async startSubTask(
    taskId: string,
    subTaskId: string,
    params?: {
      metadata?: Metadata;
    },
  ) {
    try {
      const ts = new Date().getTime();
      const metadata = params?.metadata
        ? JSON.stringify(params.metadata)
        : 'null';

      await this.redisEvalScript(
        this.subTaskInProgressLua,
        4,
        taskId,
        subTaskId,
        ts,
        metadata,
      );
    } catch (error) {
      patchError(error, 'Error in startSubTask');

      throw error;
    }
  }

  async failSubTask(
    taskId: string,
    subTaskId: string,
    params?: {
      metadata?: Metadata;
    },
  ) {
    try {
      const ts = new Date().getTime();
      const metadata = params?.metadata
        ? JSON.stringify(params.metadata)
        : 'null';

      await this.redisEvalScript(
        this.subTaskFailedLua,
        4,
        taskId,
        subTaskId,
        ts,
        metadata,
      );
    } catch (error) {
      patchError(error, 'Error in failSubTask');

      throw error;
    }
  }

  async isSubTaskComplete(taskId: string, subTaskId: string): Promise<boolean> {
    try {
      const seqId = await this.redis.hget(this.tasksIndexKey, taskId);
      const has = await this.redis.sismember(
        `${this.remainingSubTasksPrefix}:${seqId}`,
        subTaskId,
      );

      return !has;
    } catch (error) {
      patchError(error, 'Error in isSubTaskComplete');

      throw error;
    }
  }

  async waitReadiness(): Promise<void> {
    return this.ready;
  }

  /**
   * Points returns in ascending order
   */
  async getSubTaskPoints(
    taskId: string,
    subTaskId: string,
  ): Promise<SubTaskPoint[]> {
    try {
      const seqId = await this.redis.hget(this.tasksIndexKey, taskId);
      const points = await this.redis.zrange(
        `${this.subTaskPointPrefix}:${seqId}:${subTaskId}`,
        0,
        -1,
      );

      return points.map((point) => {
        const dbPoint = JSON.parse(point) as SubTaskPointDbState;
        const metadata = JSON.parse(
          dbPoint.metadata || 'null',
        ) as Metadata | null;

        return {
          subTaskId,
          event: dbPoint.event,
          timestamp: parseInt(dbPoint.timestamp, 10),
          metadata,
        };
      });
    } catch (error) {
      patchError(error, 'Error in getSubTaskPoints');

      throw error;
    }
  }

  // todo: add task group id
  // todo: implement clearing old jobs
  // todo: handle not found
  // todo: fix attempts count
  // todo: add task expireAt?
  // todo: add tasks dependencies (relation between ids)
  // todo: add feature "Set task to optional". If task is optional it shouldn't be waited to complete task
  // todo: add cancel task
}
