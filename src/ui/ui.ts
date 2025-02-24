import express from 'express';
import type { Redis } from 'ioredis';
import path from 'path';
import fs from 'fs';
import { TaskTracker } from '../lib';
import Handlebars from 'handlebars';
import { SubTaskEvents, SubTaskStates } from '../tracker';
import {
  COMPLETE_COLOR,
  FAIL_COLOR,
  IN_PROGRESS_COLOR,
  NEW_COLOR,
} from './constants';
import { prettifyUnixTs } from './utils';

Handlebars.registerHelper('valOr', function(obj, key) {
  return obj[key] || '-';
});

export interface UIOptions {
  redis: Redis;
  client: TaskTracker;
  pathPrefix?: string;
  metadataSettings?: {
    tasksMetadataColumns?: {
      key: string;
    }[];
    // subTasksMetadataColumns?: {
    //   key: string;
    // }[]
  }
}

const DEFAULT_PARAMS: Omit<Required<UIOptions>, 'redis' | 'client'> = {
  pathPrefix: '/rtm',
  metadataSettings: {
    tasksMetadataColumns: [],
    // subTasksMetadataColumns: [],
  }
};

const STATIC_PATH = path.join(__dirname, 'static');
const TEMPLATES_PATH = path.join(__dirname, 'templates');

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

const HB_POINTS = Handlebars.compile(
  fs.readFileSync(path.join(TEMPLATES_PATH, 'points.handlebars'), 'utf-8'),
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

export function expressUiServer(options: UIOptions): express.Router {
  const pathPrefix = options.pathPrefix || DEFAULT_PARAMS.pathPrefix;

  const app = express.Router();

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

  const renderPointsPage = render.bind(null, HB_LAYOUT, HB_POINTS, {
    serverPrefix: pathPrefix,
  });

  app.use(`${pathPrefix}/static`, express.static(STATIC_PATH));

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

      await Promise.all(
        recentTasks.map(async task => {
          const subtasks = await options.client.getSubTasks(task.taskId);

          subTasksStats.total += subtasks.length;

          subtasks.forEach(subtask => {
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
              case SubTaskStates.New:
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
          recentTasks: recentTasks.slice(0, 5).map(task => ({
            name: task.name || task.taskId,
            pageUrl: `${pathPrefix}/tasks/${task.seqId}`,
          })),
        }),
      );
    } catch (e) {
      next(e);
    }
  });

  app.get(`${pathPrefix}/tasks`, async (req, res, next) => {
    try {
      const tasks = await options.client.getTasks();

      const mappedTasks = tasks.map((task) => {
        const metadata: string[] = [];

        options.metadataSettings?.tasksMetadataColumns?.forEach((col, idx) => {
          if (typeof task.metadata?.[col.key] !== 'undefined') {
            metadata.push(String(task.metadata[col.key]));
          } else {
            metadata.push('-')
          }
        });

        return {
          taskId: task.taskId,
          seqId: task.seqId,
          name: task.name || '-',
          completeAt: task.completeAt || '-',
          completedColor: COMPLETE_COLOR,
          notCompletedColor: NEW_COLOR,
          pageUrl: `${pathPrefix}/tasks/${task.seqId}`,
          metadata,
        };;
      });

      res.send(
        renderTasksPage({
          pageTitle: 'Tasks',
          tasks: mappedTasks,
        }),
      );
    } catch (e) {
      next(e);
    }
  });

  app.get(`${pathPrefix}/tasks/:seqId`, async (req, res, next) => {
    try {
      const [task] = await options.client.getTasks({
        seqIds: [req.params.seqId],
      });

      const subtasks = await options.client.getSubTasks(task.taskId);

      res.send(
        renderTaskPage({
          pageTitle: 'Task',
          subtasks: subtasks.map(subtask => ({
            ...subtask,
            startedAt: subtask.startedAt
              ? prettifyUnixTs(subtask.startedAt)
              : '-',
            failedAt: subtask.failedAt ? prettifyUnixTs(subtask.failedAt) : '-',
            completedAt: subtask.completedAt
              ? prettifyUnixTs(subtask.completedAt)
              : '-',
            ...mapTaskState(subtask.state),
            pageUrl: `${pathPrefix}/tasks/${task.seqId}/subtasks/${subtask.subTaskId}/points`,
          })),
        }),
      );
    } catch (e) {
      next(e);
    }
  });

  app.get(
    `${pathPrefix}/tasks/:seqId/subtasks/:subtaskId/points`,
    async (req, res, next) => {
      try {
        const [task] = await options.client.getTasks({
          seqIds: [req.params.seqId],
        });

        const points = await options.client.getSubTaskPoints(
          task.taskId,
          req.params.subtaskId,
        );

        const extendedPoints = [
          {
            subTaskId: req.params.subtaskId,
            event: SubTaskEvents.Added,
            timestamp: task.addedAt,
          },
          ...points,
        ];

        res.send(
          renderPointsPage({
            pageTitle: 'Points',
            points: extendedPoints.map(point => ({
              ...point,
              timestamp: prettifyUnixTs(point.timestamp),
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
      }
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
    case SubTaskStates.New:
      return {
        state: 'New',
        stateColor: NEW_COLOR,
      };
    default:
      return {
        state,
        stateColor: NEW_COLOR,
      };
  }
}
