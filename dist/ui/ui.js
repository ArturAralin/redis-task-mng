"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.expressUiServer = expressUiServer;
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const handlebars_1 = __importDefault(require("handlebars"));
const tracker_1 = require("../tracker");
const constants_1 = require("./constants");
const utils_1 = require("./utils");
handlebars_1.default.registerHelper('valOr', function (obj, key) {
    return obj[key] || '-';
});
const DEFAULT_PARAMS = {
    pathPrefix: '/rtm',
    metadataSettings: {
        tasksMetadataColumns: [],
        // subTasksMetadataColumns: [],
    }
};
const STATIC_PATH = path_1.default.join(__dirname, 'static');
const TEMPLATES_PATH = path_1.default.join(__dirname, 'templates');
const HB_LAYOUT = handlebars_1.default.compile(fs_1.default.readFileSync(path_1.default.join(TEMPLATES_PATH, 'layouts', 'main.handlebars'), 'utf-8'));
const HB_DASHBOARD = handlebars_1.default.compile(fs_1.default.readFileSync(path_1.default.join(TEMPLATES_PATH, 'dashboard.handlebars'), 'utf-8'));
const HB_TASKS = handlebars_1.default.compile(fs_1.default.readFileSync(path_1.default.join(TEMPLATES_PATH, 'tasks.handlebars'), 'utf-8'));
const HB_TASK = handlebars_1.default.compile(fs_1.default.readFileSync(path_1.default.join(TEMPLATES_PATH, 'task.handlebars'), 'utf-8'));
const HB_SUBTASK = handlebars_1.default.compile(fs_1.default.readFileSync(path_1.default.join(TEMPLATES_PATH, 'subtask.handlebars'), 'utf-8'));
function render(layout, page, commonContext, pageContext) {
    const { pageTitle, ...restFields } = pageContext;
    return layout({
        ...commonContext,
        pageTitle,
        body: page({
            ...commonContext,
            ...restFields,
        }),
    });
}
// todo: add breadcrumbs
// todo: add search and filters
// todo: add retry callback
function expressUiServer(options) {
    const pathPrefix = options.pathPrefix || DEFAULT_PARAMS.pathPrefix;
    const app = express_1.default.Router();
    const renderDashboardPage = render.bind(null, HB_LAYOUT, HB_DASHBOARD, {
        serverPrefix: pathPrefix,
    });
    const renderTasksPage = render.bind(null, HB_LAYOUT, HB_TASKS, {
        serverPrefix: pathPrefix,
        ...options.metadataSettings,
    });
    const renderTaskPage = render.bind(null, HB_LAYOUT, HB_TASK, {
        serverPrefix: pathPrefix,
        ...options.metadataSettings,
    });
    const renderSubTaskPointsPage = render.bind(null, HB_LAYOUT, HB_SUBTASK, {
        serverPrefix: pathPrefix,
    });
    app.use(`${pathPrefix}/static`, express_1.default.static(STATIC_PATH));
    app.get(`${pathPrefix}/dashboard`, async (req, res, next) => {
        try {
            const now = new Date();
            const dayBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const recentTasks = await options.client.getTasks({
                range: {
                    from: dayBefore,
                    to: now,
                },
            });
            const subTasksStats = {
                total: 0,
                failed: 0,
                completed: 0,
                inProgress: 0,
                new: 0,
            };
            await Promise.all(recentTasks.map(async (task) => {
                const subtasks = await options.client.getSubTasks(task.taskId);
                subTasksStats.total += subtasks.length;
                subtasks.forEach(subtask => {
                    switch (subtask.state) {
                        case tracker_1.SubTaskStates.Complete:
                            subTasksStats.completed++;
                            break;
                        case tracker_1.SubTaskStates.Failed:
                            subTasksStats.failed++;
                            break;
                        case tracker_1.SubTaskStates.InProgress:
                            subTasksStats.inProgress++;
                            break;
                        case tracker_1.SubTaskStates.New:
                            subTasksStats.new++;
                            break;
                    }
                });
            }));
            res.send(renderDashboardPage({
                pageTitle: 'Dashboard',
                subTasksStats,
                recentTasks: recentTasks.slice(0, 5).map((task) => ({
                    name: task.name || task.taskId,
                    pageUrl: `${pathPrefix}/tasks/${task.seqId}`,
                    addedAt: (0, utils_1.prettifyUnixTs)(task.addedAt),
                })),
            }));
        }
        catch (e) {
            next(e);
        }
    });
    app.get(`${pathPrefix}/tasks`, async (req, res, next) => {
        try {
            const tasks = await options.client.getTasks();
            const mappedTasks = tasks.map((task) => {
                var _a, _b;
                const metadata = [];
                (_b = (_a = options.metadataSettings) === null || _a === void 0 ? void 0 : _a.tasksMetadataColumns) === null || _b === void 0 ? void 0 : _b.forEach((col, idx) => {
                    var _a;
                    if (typeof ((_a = task.metadata) === null || _a === void 0 ? void 0 : _a[col.key]) !== 'undefined') {
                        metadata.push(String(task.metadata[col.key]));
                    }
                    else {
                        metadata.push('-');
                    }
                });
                return {
                    taskId: task.taskId,
                    seqId: task.seqId,
                    name: task.name || '-',
                    completeAt: task.completeAt
                        ? (0, utils_1.prettifyUnixTs)(task.completeAt)
                        : '-',
                    addedAt: task.addedAt
                        ? (0, utils_1.prettifyUnixTs)(task.addedAt)
                        : '-',
                    // todo: add duration
                    complete: task.complete,
                    completedColor: constants_1.COMPLETE_COLOR,
                    notCompletedColor: constants_1.NEW_COLOR,
                    pageUrl: `${pathPrefix}/tasks/${task.seqId}`,
                    metadata,
                };
                ;
            });
            res.send(renderTasksPage({
                pageTitle: 'Tasks',
                tasks: mappedTasks,
            }));
        }
        catch (e) {
            next(e);
        }
    });
    app.get(`${pathPrefix}/tasks/:seqId`, async (req, res, next) => {
        try {
            const [task] = await options.client.getTasks({
                seqIds: [req.params.seqId],
            });
            const subtasks = await options.client.getSubTasks(task.taskId);
            res.send(renderTaskPage({
                pageTitle: 'Task',
                // todo: display whole metadata
                subtasks: subtasks.map(subtask => ({
                    ...subtask,
                    startedAt: subtask.startedAt
                        ? (0, utils_1.prettifyUnixTs)(subtask.startedAt)
                        : '-',
                    failedAt: subtask.failedAt ? (0, utils_1.prettifyUnixTs)(subtask.failedAt) : '-',
                    completedAt: subtask.completedAt
                        ? (0, utils_1.prettifyUnixTs)(subtask.completedAt)
                        : '-',
                    ...mapTaskState(subtask.state),
                    // todo: add duration
                    pageUrl: `${pathPrefix}/tasks/${task.seqId}/subtasks/${subtask.subTaskId}/points`,
                })),
            }));
        }
        catch (e) {
            next(e);
        }
    });
    app.get(`${pathPrefix}/tasks/:seqId/subtasks/:subtaskId/points`, async (req, res, next) => {
        try {
            const [task] = await options.client.getTasks({
                seqIds: [req.params.seqId],
            });
            const [points, [subtask]] = await Promise.all([
                options.client.getSubTaskPoints(task.taskId, req.params.subtaskId),
                options.client.getSubTasks(task.taskId, {
                    subtaskIds: [req.params.subtaskId],
                }),
            ]);
            const extendedPoints = [
                {
                    subTaskId: req.params.subtaskId,
                    event: tracker_1.SubTaskEvents.Added,
                    timestamp: task.addedAt,
                },
                ...points,
            ];
            res.send(renderSubTaskPointsPage({
                pageTitle: 'Subtask',
                subtask: {
                    ...subtask,
                    metadata: Object.entries(subtask.metadata || {}).map(([key, value]) => ({
                        key,
                        value,
                    }))
                },
                points: extendedPoints.map(point => ({
                    ...point,
                    timestamp: (0, utils_1.prettifyUnixTs)(point.timestamp),
                    ...mapPointEvent(point.event),
                })),
            }));
        }
        catch (e) {
            next(e);
        }
    });
    app.use(pathPrefix, (req, res) => {
        res.redirect(`${pathPrefix}/dashboard`);
    });
    return app;
}
function mapPointEvent(event) {
    switch (event) {
        case tracker_1.SubTaskEvents.Complete:
            return {
                event: 'Complete',
                eventColor: constants_1.COMPLETE_COLOR,
            };
        case tracker_1.SubTaskEvents.Failed:
            return {
                event: 'Failed',
                eventColor: constants_1.FAIL_COLOR,
            };
        case tracker_1.SubTaskEvents.InProgress:
            return {
                event: 'In Progress',
                eventColor: constants_1.IN_PROGRESS_COLOR,
            };
        case tracker_1.SubTaskEvents.Checkpoint:
            return {
                event: 'Checkpoint',
                eventColor: constants_1.NEW_COLOR,
            };
        case tracker_1.SubTaskEvents.Added:
            return {
                event: 'Added',
                eventColor: constants_1.NEW_COLOR,
            };
        default:
            return {
                event,
                eventColor: constants_1.NEW_COLOR,
            };
    }
}
function mapTaskState(state) {
    switch (state) {
        case tracker_1.SubTaskStates.Complete:
            return {
                state: 'Complete',
                stateColor: constants_1.COMPLETE_COLOR,
            };
        case tracker_1.SubTaskStates.Failed:
            return {
                state: 'Failed',
                stateColor: constants_1.FAIL_COLOR,
            };
        case tracker_1.SubTaskStates.InProgress:
            return {
                state: 'In Progress',
                stateColor: constants_1.IN_PROGRESS_COLOR,
            };
        case tracker_1.SubTaskStates.New:
            return {
                state: 'New',
                stateColor: constants_1.NEW_COLOR,
            };
        default:
            return {
                state,
                stateColor: constants_1.NEW_COLOR,
            };
    }
}
