import express from 'express';
import type { Redis } from 'ioredis';
import { TaskTracker } from '../lib';
export interface UIOptions {
    redis: Redis;
    client: TaskTracker;
    pathPrefix?: string;
}
export declare function expressUiServer(options: UIOptions): express.Express;
//# sourceMappingURL=ui.d.ts.map