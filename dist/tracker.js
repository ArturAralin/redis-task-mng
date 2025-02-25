"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskTracker = exports.SubTaskEvents = exports.SubTaskStates = void 0;
var SubTaskStates;
(function (SubTaskStates) {
    SubTaskStates[SubTaskStates["Failed"] = -1] = "Failed";
    SubTaskStates[SubTaskStates["New"] = 0] = "New";
    SubTaskStates[SubTaskStates["InProgress"] = 1] = "InProgress";
    SubTaskStates[SubTaskStates["Complete"] = 2] = "Complete";
})(SubTaskStates || (exports.SubTaskStates = SubTaskStates = {}));
var SubTaskEvents;
(function (SubTaskEvents) {
    SubTaskEvents[SubTaskEvents["Failed"] = -1] = "Failed";
    SubTaskEvents[SubTaskEvents["Added"] = 0] = "Added";
    SubTaskEvents[SubTaskEvents["InProgress"] = 1] = "InProgress";
    SubTaskEvents[SubTaskEvents["Complete"] = 2] = "Complete";
    SubTaskEvents[SubTaskEvents["Checkpoint"] = 3] = "Checkpoint";
})(SubTaskEvents || (exports.SubTaskEvents = SubTaskEvents = {}));
const KEY_SEPARATOR = '##!';
function dateToNumber(date) {
    if (date instanceof Date) {
        return date.getTime();
    }
    return date;
}
function mapTaskState(dbState, remainingTasks) {
    return {
        seqId: dbState.seqId,
        taskId: dbState.taskId,
        addedAt: dbState.addedAt,
        completeAt: dbState.completeAt || null,
        subtasksCount: dbState.subtasksCount,
        subtasksRemaining: remainingTasks,
        complete: remainingTasks === 0,
        name: dbState.name || null,
        metadata: dbState.metadata || null,
    };
}
function filterSeqIds(seqIds) {
    return seqIds.filter(Boolean);
}
class TaskTracker {
    constructor(params) {
        this.createTaskLua = null;
        this.completeSubTaskLua = null;
        this.subTaskInProgressLua = null;
        this.subTaskFailedLua = null;
        this.redis = params.redis;
        this.prefix = params.prefix || 'tm';
        this.tasksStateKey = `${this.prefix}:tasks`;
        this.tasksRegisterKey = `${this.prefix}:register`;
        this.subTasksStateKey = `${this.prefix}:subtasks`;
        this.subTasksRegisterPrefix = `${this.prefix}:subtasks_register`;
        this.tasksCounterKey = `${this.prefix}:tasks_counter`;
        this.tasksIndexKey = `${this.prefix}:tasks_index`;
        this.subTaskPointPrefix = `${this.prefix}:subtask_points`;
        this.ready =
            this.redis.status === 'ready'
                ? this.init()
                : new Promise((resolve, reject) => {
                    this.redis.once('ready', async () => {
                        await this.init();
                        resolve();
                    });
                    this.redis.once('error', err => {
                        reject(err);
                    });
                });
    }
    async init() {
        const luaStoreSubTaskPoint = `
      local seq_id = KEYS[1]
      local subtask_id = KEYS[2]
      local timestamp = tonumber(KEYS[3])
      local event = KEYS[4]

      local function store_event(seq_id, subtask_id, timestamp, event)
        local key = '${this.subTaskPointPrefix}:' .. seq_id .. ':' .. subtask_id
        local record = {}
        record['timestamp'] = timestamp
        record['event'] = event

        redis.call('ZADD', key, timestamp, cjson.encode(record))
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

      redis.call('SADD', '${this.subTasksRegisterPrefix}:' .. seq_id, unpack(ARGV))

      for _, st_id in ipairs(ARGV) do
        redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, st_id .. '${KEY_SEPARATOR}state', ${SubTaskStates.New})
      end

      return 1
    `;
        const luaCompleteSubTask = `
      ${luaStoreSubTaskPoint}

      local task_id = KEYS[1]
      local subtask_id = KEYS[2]
      local completed_at = tonumber(KEYS[3])

      local seq_id = redis.call('HGET', '${this.tasksIndexKey}', task_id)

      local current_state = redis.call('HGET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}state')

      -- use > or <
      if current_state ~= '${SubTaskStates.InProgress}' then
        error('Subtask is not in progress')
      end

      redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}state', ${SubTaskStates.Complete})
      redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}finished_at', completed_at)
      redis.call('SREM', '${this.subTasksRegisterPrefix}:' .. seq_id, subtask_id)

      local remaining_tasks = redis.call('SCARD', '${this.subTasksRegisterPrefix}:' .. seq_id)

      if remaining_tasks == 0 then
        local task_json_state = redis.call('HGET', '${this.tasksStateKey}', seq_id)
        local task_state = cjson.decode(task_json_state)
        task_state['completeAt'] = completed_at

        redis.call('HSET', '${this.tasksStateKey}', seq_id, cjson.encode(task_state))
      end

      store_event(seq_id, subtask_id, completed_at, ${SubTaskEvents.Complete})

      return remaining_tasks
    `;
        const luaSubTaskInProgress = `
      ${luaStoreSubTaskPoint}

      local task_id = KEYS[1]
      local subtask_id = KEYS[2]
      local started_at = KEYS[3]
      local seq_id = redis.call('HGET', '${this.tasksIndexKey}', task_id)

      local current_state = redis.call('HGET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}state')

      if current_state == '${SubTaskStates.New}' or current_state == '${SubTaskStates.Failed}' then
        redis.call('HINCRBY', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}attempts', 1)
      end

      redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}state', ${SubTaskStates.InProgress})
      redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}started_at', started_at)

      store_event(seq_id, subtask_id, started_at, ${SubTaskEvents.InProgress})
    `;
        const luaSubTaskFailed = `
      ${luaStoreSubTaskPoint}

      local task_id = KEYS[1]
      local subtask_id = KEYS[2]
      local failed_at = KEYS[3]

      local seq_id = redis.call('HGET', '${this.tasksIndexKey}', task_id)

      local current_state = redis.call('HGET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}state')

      -- use > or <
      if current_state ~= '${SubTaskStates.InProgress}' then
        error('Subtask is not in progress')
      end

      redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}state', ${SubTaskStates.Failed})
      redis.call('HSET', '${this.subTasksStateKey}:' .. seq_id, subtask_id .. '${KEY_SEPARATOR}failed_at', failed_at)

      store_event(seq_id, subtask_id, failed_at, ${SubTaskEvents.Failed})
    `;
        this.createTaskLua = (await this.redis.script('LOAD', luaCreateTask));
        this.completeSubTaskLua = (await this.redis.script('LOAD', luaCompleteSubTask));
        this.subTaskInProgressLua = (await this.redis.script('LOAD', luaSubTaskInProgress));
        this.subTaskFailedLua = (await this.redis.script('LOAD', luaSubTaskFailed));
    }
    /**
     * Create a new task. Creation is idempotent by taskId key
     */
    async createTask(taskId, params) {
        // todo: validate sub task ids /a-z0-9_-/
        if (params.subtasks.length === 0) {
            throw new Error('No subtasks');
        }
        if (!this.createTaskLua) {
            throw new Error('TaskTracker not initialized');
        }
        const seqId = await this.redis.incr(this.tasksCounterKey);
        const taskState = {
            taskId,
            seqId,
            addedAt: Date.now(),
            subtasksCount: params.subtasks.length,
            name: params.name,
            metadata: params.metadata,
            v: 1,
        };
        const subtasksIds = params.subtasks.map(subtask => subtask.subTaskId);
        const createTaskResult = await this.redis.evalsha(this.createTaskLua, 4, seqId, taskId, Date.now(), JSON.stringify(taskState), ...subtasksIds);
        return {
            seqId,
            created: createTaskResult === 1,
        };
    }
    async getTasks(params = {}) {
        var _a, _b;
        const range = params.range || {
            from: 0,
            to: Number.MAX_SAFE_INTEGER,
        };
        let seqIds;
        if (params.seqIds) {
            seqIds = params.seqIds;
        }
        else if (params.taskIds) {
            // todo: add debug message
            seqIds = filterSeqIds(await this.redis.hmget(this.tasksIndexKey, ...params.taskIds));
        }
        else {
            seqIds = await this.redis.zrange(this.tasksRegisterKey, dateToNumber(range.to), dateToNumber(range.from), 'BYSCORE', 'REV', 'LIMIT', ((_a = params.pagination) === null || _a === void 0 ? void 0 : _a.offset) || 0, ((_b = params.pagination) === null || _b === void 0 ? void 0 : _b.limit) || Number.MAX_SAFE_INTEGER);
        }
        if (seqIds.length === 0) {
            return [];
        }
        const uniqTaskIds = Array.from(new Set(seqIds));
        const rems = Promise.all(uniqTaskIds.map(seqId => this.redis.scard(`${this.subTasksRegisterPrefix}:${seqId}`)));
        const [tasks, subTasksRemainingJobs] = await Promise.all([
            this.redis.hmget(this.tasksStateKey, ...uniqTaskIds),
            rems,
        ]);
        const taskStates = [];
        tasks.forEach((taskState, idx) => {
            if (!taskState) {
                // todo: add debug message
                return;
            }
            const state = JSON.parse(taskState);
            taskStates.push(mapTaskState(state, subTasksRemainingJobs[idx]));
        });
        return taskStates;
    }
    async getTaskState(taskId) {
        const tasks = await this.getTasks({ taskIds: [taskId] });
        return tasks[0] || null;
    }
    async getSubTasks(taskId) {
        const seqId = await this.redis.hget(this.tasksIndexKey, taskId);
        const subtasks = await this.redis.hgetall(`${this.subTasksStateKey}:${seqId}`);
        const states = new Map();
        Object.entries(subtasks).forEach(([redisKey, value]) => {
            const idx = redisKey.indexOf(KEY_SEPARATOR);
            if (idx === -1) {
                throw new Error(`Invalid key "${redisKey}"`);
            }
            const subtaskId = redisKey.slice(0, idx);
            const key = redisKey.slice(idx + 3);
            const state = states.get(subtaskId) || {
                subTaskId: subtaskId,
                state: SubTaskStates.New,
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
                    state.state = parseInt(value, 10);
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
    async completeSubTask(taskId, subTaskId) {
        if (!this.completeSubTaskLua) {
            throw new Error('TaskTracker not initialized');
        }
        const ts = new Date().getTime();
        const remainingTasks = await this.redis.evalsha(this.completeSubTaskLua, 3, taskId, subTaskId, ts);
        return {
            allTasksCompleted: remainingTasks === 0,
        };
    }
    async startSubTask(taskId, subTaskId) {
        if (!this.subTaskInProgressLua) {
            throw new Error('TaskTracker not initialized');
        }
        const ts = new Date().getTime();
        await this.redis.evalsha(this.subTaskInProgressLua, 3, taskId, subTaskId, ts);
    }
    async failSubTask(taskId, subTaskId) {
        if (!this.subTaskFailedLua) {
            throw new Error('TaskTracker not initialized');
        }
        const ts = new Date().getTime();
        await this.redis.evalsha(this.subTaskFailedLua, 3, taskId, subTaskId, ts);
    }
    async isSubTaskComplete(taskId, subTaskId) {
        const seqId = await this.redis.hget(this.tasksIndexKey, taskId);
        const has = await this.redis.sismember(`${this.subTasksRegisterPrefix}:${seqId}`, subTaskId);
        return !has;
    }
    async waitReadiness() {
        return this.ready;
    }
    async getSubTaskPoints(taskId, subTaskId) {
        const seqId = await this.redis.hget(this.tasksIndexKey, taskId);
        const points = await this.redis.zrange(`${this.subTaskPointPrefix}:${seqId}:${subTaskId}`, 0, -1);
        return points.map(point => {
            const dbPoint = JSON.parse(point);
            return {
                subTaskId,
                event: dbPoint.event,
                timestamp: parseInt(dbPoint.timestamp, 10),
            };
        });
    }
}
exports.TaskTracker = TaskTracker;
