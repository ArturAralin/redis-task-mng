import type { Redis } from 'ioredis';
export declare enum SubTaskStates {
    Failed = -1,
    New = 0,
    InProgress = 1,
    Complete = 2
}
export declare enum SubTaskEvents {
    Failed = -1,
    Added = 0,
    InProgress = 1,
    Complete = 2,
    Checkpoint = 3
}
type Metadata = Record<string, string | number | boolean>;
export interface CreateSubTask {
    subTaskId: string;
}
export interface SubTaskState {
    subTaskId: string;
    state: SubTaskStates;
    attempts: number;
    startedAt: number | null;
    completedAt: number | null;
    failedAt: number | null;
}
export interface TaskState {
    taskId: string;
    seqId: number;
    name: string | null;
    addedAt: number;
    completeAt: number | null;
    subtasksCount: number;
    subtasksRemaining: number;
    metadata: Metadata | null;
    complete: boolean;
}
interface SubTaskPoint {
    subTaskId: string;
    event: SubTaskEvents;
    timestamp: number;
}
interface TaskTrackerParams {
    redis: Redis;
    prefix?: string;
}
export declare class TaskTracker {
    private redis;
    private ready;
    private prefix;
    private tasksStateKey;
    private tasksRegisterKey;
    private subTasksStateKey;
    private subTasksRegisterPrefix;
    private tasksCounterKey;
    private tasksIndexKey;
    private subTaskPointPrefix;
    private createTaskLua;
    private completeSubTaskLua;
    private subTaskInProgressLua;
    private subTaskFailedLua;
    constructor(params: TaskTrackerParams);
    private init;
    /**
     * Create a new task. Creation is idempotent by taskId key
     */
    createTask(taskId: string, params: {
        name?: string;
        metadata?: Metadata;
        subtasks: CreateSubTask[];
    }): Promise<{
        seqId: number;
    }>;
    getTasks(params?: {
        range?: {
            from: Date | number;
            to: Date | number;
        };
        seqIds?: string[];
        taskIds?: string[];
        pagination?: {
            limit?: number;
            offset?: number;
        };
    }): Promise<TaskState[]>;
    getTaskState(taskId: string): Promise<TaskState | null>;
    getSubTasks(taskId: string): Promise<SubTaskState[]>;
    completeSubTask(taskId: string, subTaskId: string): Promise<{
        allTasksCompleted: boolean;
    }>;
    startSubTask(taskId: string, subTaskId: string): Promise<void>;
    failSubTask(taskId: string, subTaskId: string): Promise<void>;
    isSubTaskComplete(taskId: string, subTaskId: string): Promise<boolean>;
    waitReadiness(): Promise<void>;
    getSubTaskPoints(taskId: string, subTaskId: string): Promise<SubTaskPoint[]>;
}
export {};
//# sourceMappingURL=tracker.d.ts.map