import express from 'express';
import { type Redis } from 'ioredis';
import path from 'path';
import fs from 'fs';
import { TaskTracker } from '../lib';
import Handlebars from 'handlebars';
import { sub, parseISO, formatDate, startOfSecond } from 'date-fns';
import {
  Metadata,
  SubTaskEvents,
  SubTaskState,
  SubTaskStates,
  TaskState,
} from '../tracker';
import {
  COMPLETE_COLOR,
  FAIL_COLOR,
  IN_PROGRESS_COLOR,
  NEW_COLOR,
} from './constants';
import { durationPretty, getTimezones, prettifyUnixTs } from './utils';
import cookieParser from 'cookie-parser';

Handlebars.registerHelper('ifEquals', function (arg1, arg2, options) {
  /* eslint-disable */
  // @ts-ignore
  return arg1 == arg2
    ? // @ts-ignore
      options.fn(this as unknown)
    : // @ts-ignore
      (options.inverse(this as unknown) as unknown);
  /* eslint-enable */
});

export interface UITextColumn {
  type: 'text';
  text: string;
}

export interface UIUrlColumn {
  type: 'url';
  url: string;
  text?: string;
}

export type UIColumn = UITextColumn | UIUrlColumn;

export interface UIOptions {
  redis: Redis;
  client: TaskTracker;
  pathPrefix?: string;

  tasksSection?: {
    proceduralColumns?: {
      name: string;
      mapper: (task: TaskState) => UIColumn | null;
    }[];
  };
  subtasksSection?: {
    onRetryAction?: (
      subTask: SubTaskState,
      task: TaskState,
    ) => void | Promise<void>;
    showRetryAction?: (
      subTask: SubTaskState,
      task: TaskState,
    ) => boolean | undefined | null;
  };
}

function displayUIColumn(column: UIColumn) {
  if (column.type === 'text') {
    return column.text;
  }

  if (column.type === 'url') {
    const linkText =
      column.text ||
      (column.url.length > 40 ? `${column.url.slice(0, 37)}...` : column.url);

    return `<a target="_blank" href="${encodeURI(column.url)}">${linkText}</a>`;
  }

  return '-';
}

const DEFAULT_PARAMS: Omit<Required<UIOptions>, 'redis' | 'client'> = {
  pathPrefix: '/rtm',
  tasksSection: {
    proceduralColumns: [],
  },
  subtasksSection: {},
};

const QUERY_ALLOWED_SYMBOLS = /[ a-zа-я0-9_-ё]/i;

const STATIC_PATH = path.join(__dirname, 'static');
const TEMPLATES_PATH = path.join(__dirname, 'templates');

const COOKIES_TZ_NAME = 'tz_offset';

const HB_LAYOUT = Handlebars.compile(
  fs.readFileSync(
    path.join(TEMPLATES_PATH, 'layouts', 'main.handlebars'),
    'utf-8',
  ),
);

const HB_DASHBOARD = Handlebars.compile(
  fs.readFileSync(path.join(TEMPLATES_PATH, 'dashboard.handlebars'), 'utf-8'),
);

const HB_TASKS = Handlebars.compile(
  fs.readFileSync(path.join(TEMPLATES_PATH, 'tasks.handlebars'), 'utf-8'),
);

const HB_TASK = Handlebars.compile(
  fs.readFileSync(path.join(TEMPLATES_PATH, 'task.handlebars'), 'utf-8'),
);

const HB_SUBTASK = Handlebars.compile(
  fs.readFileSync(path.join(TEMPLATES_PATH, 'subtask.handlebars'), 'utf-8'),
);

function render(
  layout: HandlebarsTemplateDelegate,
  page: HandlebarsTemplateDelegate,
  commonContext: Record<string, unknown>,
  pageContext: {
    pageTitle: string;
    [k: string]: unknown;
  },
): string {
  const { pageTitle, timezones = [], ...restFields } = pageContext;

  return layout({
    ...commonContext,
    pageTitle,
    timezones,
    body: page({
      ...commonContext,
      ...restFields,
    }),
  });
}

function getTaskName(task: TaskState): string {
  return task.name || task.taskId;
}

function getSubTaskName(subTask: SubTaskState): string {
  return subTask.name || subTask.subTaskId;
}

function getSubTaskDuration(subTask: SubTaskState): number | null {
  const endedAt = subTask.completedAt || subTask.failedAt;

  if (endedAt && subTask.startedAt) {
    return endedAt - subTask.startedAt;
  }

  return null;
}

interface MetadataKeyValue {
  key: string;
  value: unknown;
}

function metadataToKeyValue(metadata: Metadata | null): MetadataKeyValue[] {
  return Object.entries(metadata || {}).map(([key, value]) => ({
    key,
    value,
  }));
}

// todo: add breadcrumbs

const TIME_UNIT_REGEX = /(?<value>\d+)(?<unit>h)/i;

function extractPeriodFilter(query: unknown) {
  if (typeof query !== 'object' || query === null) {
    return {
      from: 0,
      to: Date.now(),
      default: true,
    };
  }

  const params = query as Partial<Record<string, string>>;

  if (params.period) {
    const match = params.period.match(TIME_UNIT_REGEX);

    if (match?.groups?.unit && match?.groups?.value) {
      const now = new Date();

      return {
        from: sub(now, {
          hours: parseInt(match.groups.value, 10),
        }).getTime(),
        to: now.getTime(),
        default: false,
      };
    }
  }

  const from = params.period_from ? parseISO(params.period_from).getTime() : 0;

  const to = params.period_to
    ? parseISO(params.period_to).getTime()
    : Date.now();

  return {
    from,
    to,
    default: false,
  };
}

function getQueryRegex(query: unknown): RegExp | null {
  if (typeof query !== 'object' || query === null) {
    return null;
  }

  const params = query as Partial<Record<string, string>>;

  if (params.query && typeof params.query === 'string') {
    if (!QUERY_ALLOWED_SYMBOLS.test(params.query)) {
      throw new Error('Query contains disallowed symbols');
    }

    return new RegExp(`.*${params.query}.*`, 'i');
  }

  return null;
}

function getTimezoneOffset(req: express.Request): number {
  if (req.cookies[COOKIES_TZ_NAME]) {
    return parseInt(req.cookies[COOKIES_TZ_NAME], 10);
  }

  return 0;
}

export function expressUiServer(options: UIOptions): express.Router {
  const pathPrefix = options.pathPrefix || DEFAULT_PARAMS.pathPrefix;

  const app = express.Router();

  const renderDashboardPage = render.bind(null, HB_LAYOUT, HB_DASHBOARD, {
    serverPrefix: pathPrefix,
  });

  const renderTasksPage = render.bind(null, HB_LAYOUT, HB_TASKS, {
    serverPrefix: pathPrefix,
    ...options.tasksSection,
  });

  const renderTaskPage = render.bind(null, HB_LAYOUT, HB_TASK, {
    serverPrefix: pathPrefix,
    ...options.subtasksSection,
  });

  const renderSubTaskPointsPage = render.bind(null, HB_LAYOUT, HB_SUBTASK, {
    serverPrefix: pathPrefix,
  });

  const showActionsColumn = Boolean(
    options.subtasksSection?.showRetryAction &&
      options.subtasksSection?.onRetryAction,
  );

  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(`${pathPrefix}/static`, express.static(STATIC_PATH));

  app.post(`${pathPrefix}/timezone`, async (req, res, next) => {
    const timezone = req.body.timezone;

    if (timezone) {
      const offset = parseInt(timezone, 10);

      res.cookie(COOKIES_TZ_NAME, offset, {
        maxAge: 1000 * 60 * 60 * 24 * 365,
      });
    }

    if (req.headers.referer) {
      res.redirect(req.headers.referer);
    } else {
      res.redirect(pathPrefix);
    }
  });

  app.get(`${pathPrefix}/dashboard`, async (req, res, next) => {
    const tzOffset = getTimezoneOffset(req);
    const prettifyUnixTsZoned = prettifyUnixTs.bind(null, tzOffset);

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

      const subTasksWithDuration: [TaskState, SubTaskState][] = [];

      await Promise.all(
        recentTasks.map(async (task) => {
          const subtasks = await options.client.getSubTasks(task.taskId);

          subTasksStats.total += subtasks.length;

          subtasks.forEach((subtask) => {
            const duration = getSubTaskDuration(subtask);

            if (duration !== null) {
              subTasksWithDuration.push([task, subtask]);
            }

            switch (subtask.state) {
              case SubTaskStates.Complete:
                subTasksStats.completed++;
                break;
              case SubTaskStates.Failed:
                subTasksStats.failed++;
                break;
              case SubTaskStates.InProgress:
                subTasksStats.inProgress++;
                break;
              case SubTaskStates.Waiting:
                subTasksStats.new++;
                break;
            }
          });
        }),
      );

      res.send(
        renderDashboardPage({
          pageTitle: 'Dashboard',
          subTasksStats,
          timezones: getTimezones(tzOffset),
          longestSubtasks: subTasksWithDuration
            .sort(([, a], [, b]) => {
              return (
                (getSubTaskDuration(b) || 0) - (getSubTaskDuration(a) || 0)
              );
            })
            .slice(0, 5)
            .map(([task, subtask]) => {
              const duration = getSubTaskDuration(subtask);

              return {
                name: `${getTaskName(task)} - ${getSubTaskName(subtask)}`,
                pageUrl: `${pathPrefix}/tasks/${task.seqId}/subtasks/${subtask.subTaskId}/points`,
                duration: duration ? durationPretty(duration) : '-',
              };
            }),
          recentTasks: recentTasks.slice(0, 5).map((task) => ({
            name: task.name || task.taskId,
            pageUrl: `${pathPrefix}/tasks/${task.seqId}`,
            addedAt: prettifyUnixTsZoned(task.addedAt),
          })),
        }),
      );
    } catch (e) {
      next(e);
    }
  });

  app.get(`${pathPrefix}/tasks`, async (req, res, next) => {
    const tzOffset = getTimezoneOffset(req);
    const prettifyUnixTsZoned = prettifyUnixTs.bind(null, tzOffset);

    // Force 24h period if not specified
    if (!req.query.period) {
      const url = new URL(req.originalUrl, 'http://host');
      url.searchParams.delete('period');
      url.searchParams.append('period', '24h');

      res.redirect(`${url.pathname}${url.search}`);

      return;
    }

    const range = extractPeriodFilter(req.query);

    try {
      const queryRegex = getQueryRegex(req.query);

      const tasks = await options.client.getTasks({
        range,
        ...(range.default && {
          pagination: {
            limit: 500,
          },
        }),
        ...(req.query.keep_completed && {
          keepCompleted: req.query.keep_completed == 'on',
        }),
        ...(req.query.keep_failed && {
          keepFailed: req.query.keep_failed == 'on',
        }),
        ...(req.query.keep_in_progress && {
          keepInProgress: req.query.keep_in_progress == 'on',
        }),
      });

      const mappedTasks: Record<string, unknown>[] = [];

      for (const task of tasks) {
        if (queryRegex) {
          const keepRow =
            queryRegex.test(task.taskId) ||
            (task.name && queryRegex.test(task.name));

          if (!keepRow) {
            continue;
          }
        }

        const metadata: string[] = [];

        options.tasksSection?.proceduralColumns?.forEach((col) => {
          const columnValue = col.mapper(task);

          if (columnValue) {
            metadata.push(displayUIColumn(columnValue));
          } else {
            metadata.push('-');
          }
        });

        mappedTasks.push({
          taskId: task.taskId,
          seqId: task.seqId,
          name: getTaskName(task),
          completeAt: task.completeAt
            ? prettifyUnixTsZoned(task.completeAt)
            : '-',
          addedAt: task.addedAt ? prettifyUnixTsZoned(task.addedAt) : '-',
          // todo: add duration
          complete: task.complete,
          hasFailed: task.subtasksFailed > 0,
          completedColor: COMPLETE_COLOR,
          notCompletedColor: NEW_COLOR,
          failedColor: FAIL_COLOR,
          pageUrl: `${pathPrefix}/tasks/${task.seqId}`,
          metadata,
        });
      }

      res.send(
        renderTasksPage({
          pageTitle: 'Tasks',
          query: req.query,
          tasks: mappedTasks,
          timezones: getTimezones(tzOffset),
        }),
      );
    } catch (e) {
      next(e);
    }
  });

  app.get(`${pathPrefix}/tasks/:seqId`, async (req, res, next) => {
    const tzOffset = getTimezoneOffset(req);
    const prettifyUnixTsZoned = prettifyUnixTs.bind(null, tzOffset);

    try {
      const [task] = await options.client.getTasks({
        seqIds: [req.params.seqId],
      });

      const subtasks = await options.client.getSubTasks(task.taskId);

      const subtasksStatesByDates = Object.create(null) as Record<
        string,
        Record<string, SubTaskEvents>
      >;
      const quants = new Set<number>();

      await Promise.all(
        subtasks.map(async (subtask) => {
          const points = await options.client.getSubTaskPoints(
            task.taskId,
            subtask.subTaskId,
          );

          for (const point of points) {
            const date = startOfSecond(new Date(point.timestamp)).getTime();

            subtasksStatesByDates[date] = subtasksStatesByDates[date] || {};
            subtasksStatesByDates[date][point.subTaskId] = point.event;
            quants.add(date);
          }
        }),
      );

      const fails: number[] = [];
      const inProgress: number[] = [];
      const completed: number[] = [];
      const waiting: number[] = [];

      const orderedTimeQuants = Object.keys(subtasksStatesByDates).sort(
        (a, b) => Number(a) - Number(b),
      );

      const subTaskStates: Record<string, SubTaskEvents> = Object.fromEntries(
        subtasks.map((subtask) => [subtask.subTaskId, SubTaskEvents.Added]),
      );

      let inProgressCount = 0;
      let failedCount = 0;
      let completedCount = 0;
      let waitingCount = subtasks.length;

      for (const timeQuant of orderedTimeQuants) {
        for (const [subtaskId, newEventState] of Object.entries(
          subtasksStatesByDates[timeQuant],
        )) {
          if (newEventState !== subTaskStates[subtaskId]) {
            switch (newEventState) {
              case SubTaskEvents.InProgress: {
                inProgressCount += 1;
                break;
              }
              case SubTaskEvents.Failed: {
                failedCount += 1;
                break;
              }
              case SubTaskEvents.Complete: {
                completedCount += 1;
                break;
              }
            }

            switch (subTaskStates[subtaskId]) {
              case SubTaskEvents.InProgress: {
                inProgressCount -= 1;
                break;
              }
              case SubTaskEvents.Failed: {
                failedCount -= 1;
                break;
              }
              case SubTaskEvents.Complete: {
                completedCount -= 1;
                break;
              }
              case SubTaskEvents.Added: {
                waitingCount -= 1;
                break;
              }
            }

            subTaskStates[subtaskId] = newEventState;
          }
        }

        fails.push(failedCount);
        inProgress.push(inProgressCount);
        completed.push(completedCount);
        waiting.push(waitingCount);
      }

      const statusesDistribution = {
        labels: orderedTimeQuants.map((quant) =>
          formatDate(Number(quant), 'hh:mm:ss'),
        ),
        datasets: [
          {
            label: 'Waiting',
            data: waiting,
            backgroundColor: NEW_COLOR,
            borderColor: NEW_COLOR,
            stepped: 'middle',
          },
          {
            label: 'In progress',
            data: inProgress,
            backgroundColor: IN_PROGRESS_COLOR,
            borderColor: IN_PROGRESS_COLOR,
            stepped: 'middle',
          },
          {
            label: 'Completed',
            data: completed,
            backgroundColor: COMPLETE_COLOR,
            borderColor: COMPLETE_COLOR,
            stepped: 'middle',
          },
          {
            label: 'Failed',
            data: fails,
            backgroundColor: FAIL_COLOR,
            borderColor: FAIL_COLOR,
            stepped: 'middle',
          },
        ],
      };

      res.send(
        renderTaskPage({
          timezones: getTimezones(tzOffset),
          pageTitle: 'Task',
          showActionsColumn,
          statusesDistribution: JSON.stringify(statusesDistribution),
          task: {
            ...task,
            name: getTaskName(task),
            metadata: metadataToKeyValue(task.metadata),
          },
          subtasks: subtasks.map((subtask) => {
            const duration = getSubTaskDuration(subtask);
            return {
              ...subtask,
              showActionsColumn,
              retryActionValue: `?action=retry&sid=${task.seqId}&st_id=${subtask.subTaskId}`,
              name: getSubTaskName(subtask),
              startedAt: subtask.startedAt
                ? prettifyUnixTsZoned(subtask.startedAt)
                : '-',
              failedAt: subtask.failedAt
                ? prettifyUnixTsZoned(subtask.failedAt)
                : '-',
              completedAt: subtask.completedAt
                ? prettifyUnixTsZoned(subtask.completedAt)
                : '-',
              ...mapTaskState(subtask.state),
              duration: duration ? durationPretty(duration) : '-',
              pageUrl: `${pathPrefix}/tasks/${task.seqId}/subtasks/${subtask.subTaskId}/points`,
            };
          }),
        }),
      );
    } catch (e) {
      next(e);
    }
  });

  app.post(`${pathPrefix}/tasks/:seqId`, async (req, res, next) => {
    if (!options.subtasksSection?.onRetryAction) {
      res.redirect(`${req.path}?retry=not_configured`);

      return;
    }

    try {
      const {
        action,
        sid: seqId,
        st_id: subTaskId,
      } = req.query as Record<string, string>;

      if (action !== 'retry') {
        throw new Error('Unknown action');
      }

      if (!seqId) {
        throw new Error('Missing seqId');
      }

      if (!subTaskId) {
        throw new Error('Missing subTaskId');
      }

      const [task] = await options.client.getTasks({
        seqIds: [seqId],
      });

      const [subtask] = await options.client.getSubTasks(task.taskId, {
        subtaskIds: [subTaskId],
      });

      await options.subtasksSection.onRetryAction(subtask, task);

      res.redirect(`${req.path}?retry=success`);
    } catch (error) {
      next(error);
    }
  });

  app.get(
    `${pathPrefix}/tasks/:seqId/subtasks/:subtaskId/points`,
    async (req, res, next) => {
      const tzOffset = getTimezoneOffset(req);
      const prettifyUnixTsZoned = prettifyUnixTs.bind(null, tzOffset);

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
            event: SubTaskEvents.Added,
            timestamp: task.addedAt,
            elapsed: 0,
            metadata: [] as MetadataKeyValue[],
          },
        ];

        points.forEach((point, idx) => {
          extendedPoints.push({
            subTaskId: req.params.subtaskId,
            event: point.event,
            timestamp: point.timestamp,
            // ignore elapsed between added at and first point
            elapsed:
              idx === 0 ? 0 : point.timestamp - extendedPoints[idx].timestamp,
            metadata: metadataToKeyValue(point.metadata),
          });
        });

        res.send(
          renderSubTaskPointsPage({
            pageTitle: 'Subtask',
            timezones: getTimezones(tzOffset),
            subtask: {
              ...subtask,
              startedAt: subtask.startedAt
                ? prettifyUnixTsZoned(subtask.startedAt)
                : '-',
              failedAt: subtask.failedAt
                ? prettifyUnixTsZoned(subtask.failedAt)
                : '-',
              completedAt: subtask.completedAt
                ? prettifyUnixTsZoned(subtask.completedAt)
                : '-',
              metadata: metadataToKeyValue(subtask.metadata),
            },
            points: extendedPoints.map((point) => ({
              ...point,
              timestamp: prettifyUnixTsZoned(point.timestamp),
              elapsed: durationPretty(point.elapsed),
              ...mapPointEvent(point.event),
            })),
          }),
        );
      } catch (e) {
        next(e);
      }
    },
  );

  app.use(pathPrefix, (req, res) => {
    res.redirect(`${pathPrefix}/dashboard`);
  });

  return app;
}

function mapPointEvent(event: SubTaskEvents): {
  event: string;
  eventColor: string;
} {
  switch (event) {
    case SubTaskEvents.Complete:
      return {
        event: 'Complete',
        eventColor: COMPLETE_COLOR,
      };
    case SubTaskEvents.Failed:
      return {
        event: 'Failed',
        eventColor: FAIL_COLOR,
      };
    case SubTaskEvents.InProgress:
      return {
        event: 'In Progress',
        eventColor: IN_PROGRESS_COLOR,
      };
    case SubTaskEvents.Checkpoint:
      return {
        event: 'Checkpoint',
        eventColor: NEW_COLOR,
      };
    case SubTaskEvents.Added:
      return {
        event: 'Added',
        eventColor: NEW_COLOR,
      };
    default:
      return {
        event,
        eventColor: NEW_COLOR,
      };
  }
}

function mapTaskState(state: SubTaskStates): {
  state: string;
  stateColor: string;
} {
  switch (state) {
    case SubTaskStates.Complete:
      return {
        state: 'Complete',
        stateColor: COMPLETE_COLOR,
      };
    case SubTaskStates.Failed:
      return {
        state: 'Failed',
        stateColor: FAIL_COLOR,
      };
    case SubTaskStates.InProgress:
      return {
        state: 'In Progress',
        stateColor: IN_PROGRESS_COLOR,
      };
    case SubTaskStates.Waiting:
      return {
        state: 'Waiting',
        stateColor: NEW_COLOR,
      };
    default:
      return {
        state,
        stateColor: NEW_COLOR,
      };
  }
}
