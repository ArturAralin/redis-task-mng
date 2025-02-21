import type { Redis } from 'ioredis';
export declare enum ProgressStateEnum {
    Failed = -1,
    New = 0,
    InProgress = 1,
    Complete = 2
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
export declare class TaskTracker {
    private readonly redis;
    private prefix;
    private tasksStateKey;
    private tasksRegisterKey;
    private subTasksStateKey;
    private subTasksRegisterPrefix;
    private createTaskLua;
    private completeSubTaskLua;
    private subTaskInProgressLua;
    private subTaskFailedLua;
    constructor(redis: Redis);
    init(): Promise<void>;
    createTask(taskId: string, params: {
        name?: string;
        metadata?: Metadata;
        subtasks: CreateSubTask[];
    }): Promise<void>;
    getTasks(params?: {
        range?: {
            from: Date | number;
            to: Date | number;
        };
        taskIds?: string[];
    }): Promise<TaskState[]>;
    getTaskState(taskId: string): Promise<TaskState | null>;
    getSubTasks(taskId: string): Promise<SubTaskState[]>;
    completeSubTask(taskId: string, subTaskId: string): Promise<{
        allTasksCompleted: boolean;
    }>;
    startSubTask(taskId: string, subTaskId: string): Promise<void>;
    failSubTask(taskId: string, subTaskId: string): Promise<void>;
    isSubTaskComplete(taskId: string, subTaskId: string): Promise<boolean>;
}
export {};
//# sourceMappingURL=tracker.d.ts.map