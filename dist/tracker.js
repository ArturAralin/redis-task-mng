"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskTracker = exports.ProgressStateEnum = void 0;
var ProgressStateEnum;
(function (ProgressStateEnum) {
    ProgressStateEnum[ProgressStateEnum["Failed"] = -1] = "Failed";
    ProgressStateEnum[ProgressStateEnum["New"] = 0] = "New";
    ProgressStateEnum[ProgressStateEnum["InProgress"] = 1] = "InProgress";
    ProgressStateEnum[ProgressStateEnum["Complete"] = 2] = "Complete";
})(ProgressStateEnum || (exports.ProgressStateEnum = ProgressStateEnum = {}));
const KEY_SEPARATOR = '##!';
function dateToNumber(date) {
    if (date instanceof Date) {
        return date.getTime();
    }
    return date;
}
function mapTaskState(dbState, remainingTasks) {
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
class TaskTracker {
    constructor(redis) {
        this.redis = redis;
        this.createTaskLua = null;
        this.completeSubTaskLua = null;
        this.subTaskInProgressLua = null;
        this.subTaskFailedLua = null;
        this.prefix = 'tm';
        this.tasksStateKey = `${this.prefix}:tasks`;
        this.tasksRegisterKey = `${this.prefix}:register`;
        this.subTasksStateKey = `${this.prefix}:subtasks`;
        this.subTasksRegisterPrefix = `${this.prefix}:subtasks_register`;
    }
    init() {
        return __awaiter(this, void 0, void 0, function* () {
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
            this.createTaskLua = (yield this.redis.script('LOAD', luaCreateTask));
            this.completeSubTaskLua = (yield this.redis.script('LOAD', luaCompleteSubTask));
            this.subTaskInProgressLua = (yield this.redis.script('LOAD', luaSubTaskInProgress));
            this.subTaskFailedLua = (yield this.redis.script('LOAD', luaSubTaskFailed));
        });
    }
    createTask(taskId, params) {
        return __awaiter(this, void 0, void 0, function* () {
            if (params.subtasks.length === 0) {
                throw new Error('No subtasks');
            }
            if (!this.createTaskLua) {
                throw new Error('TaskTracker not initialized');
            }
            const existingTask = yield this.redis.exists(`${this.tasksStateKey}:${taskId}`);
            if (existingTask) {
                throw new Error(`Task with id ${taskId} already exists`);
            }
            const taskState = {
                id: taskId,
                addedAt: Date.now(),
                subtasksCount: params.subtasks.length,
                name: params.name,
                metadata: params.metadata,
                v: 1,
            };
            const subtasksIds = params.subtasks.map((subtask) => subtask.subTaskId);
            yield this.redis.evalsha(this.createTaskLua, 3, taskId, Date.now(), JSON.stringify(taskState), ...subtasksIds);
        });
    }
    getTasks() {
        return __awaiter(this, arguments, void 0, function* (params = {}) {
            const range = params.range || {
                from: 0,
                to: Date.now(),
            };
            const taskIds = params.taskIds || (yield this.redis.zrevrange(this.tasksRegisterKey, dateToNumber(range.from), dateToNumber(range.to)));
            if (taskIds.length === 0) {
                return [];
            }
            const uniqTaskIds = Array.from(new Set(taskIds));
            const rems = Promise.all(uniqTaskIds.map((taskId) => this.redis.scard(`${this.subTasksRegisterPrefix}:${taskId}`)));
            const [tasks, subTasksRemainingJobs,] = yield Promise.all([
                this.redis.hmget(this.tasksStateKey, ...uniqTaskIds),
                rems
            ]);
            const taskStates = [];
            tasks.forEach((taskState, idx) => {
                if (!taskState) {
                    // todo: add debug message
                    return;
                }
                const state = JSON.parse(taskState);
                taskStates.push(mapTaskState(state, subTasksRemainingJobs[idx]));
                taskStates.push(mapTaskState(state, subTasksRemainingJobs[idx]));
            });
            return taskStates;
        });
    }
    getTaskState(taskId) {
        return __awaiter(this, void 0, void 0, function* () {
            const tasks = yield this.getTasks({ taskIds: [taskId] });
            return tasks[0] || null;
        });
    }
    getSubTasks(taskId) {
        return __awaiter(this, void 0, void 0, function* () {
            const subtasks = yield this.redis.hgetall(`${this.subTasksStateKey}:${taskId}`);
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
        });
    }
    completeSubTask(taskId, subTaskId) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.completeSubTaskLua) {
                throw new Error('TaskTracker not initialized');
            }
            const ts = new Date().getTime();
            const remainingTasks = yield this.redis.evalsha(this.completeSubTaskLua, 3, taskId, subTaskId, ts);
            return {
                allTasksCompleted: remainingTasks === 0
            };
        });
    }
    startSubTask(taskId, subTaskId) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.subTaskInProgressLua) {
                throw new Error('TaskTracker not initialized');
            }
            const ts = new Date().getTime();
            yield this.redis.evalsha(this.subTaskInProgressLua, 3, taskId, subTaskId, ts);
        });
    }
    failSubTask(taskId, subTaskId) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.subTaskFailedLua) {
                throw new Error('TaskTracker not initialized');
            }
            const ts = new Date().getTime();
            yield this.redis.evalsha(this.subTaskFailedLua, 3, taskId, subTaskId, ts);
        });
    }
    isSubTaskComplete(taskId, subTaskId) {
        return __awaiter(this, void 0, void 0, function* () {
            const has = yield this.redis.sismember(`${this.subTasksRegisterPrefix}:${taskId}`, subTaskId);
            return !has;
        });
    }
}
exports.TaskTracker = TaskTracker;
