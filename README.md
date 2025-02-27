# !!! PACKAGE WILL BE RENAMED !!! DO NOT USE IT NOW

# Redis task mng
```javascript
async function publisher() {
  const plannedJobs = generateJobs(); // { uniqFileName: string, ... }[];
  const taskId = uuid.v4();

  await taskTracker.createTask({
    name: 'Process files',
    subtasks: plannedJobs.map((job) => ({
      subTaskId: job.uniqFileName,
    })),
  });

  publishToQueue(jobs);
}

async function consumer(msg) {
  if (await taskTracker.isSubTaskComplete(msg.taskId, msg.uniqFileName)) {
    return;
  }

  try {
    await taskTracker.startSubTask(msg.taskId, msg.uniqFileName);

    doJob();

    await taskTracker.completeSubTask(msg.taskId, msg.uniqFileName);
  } catch (error) {
    await taskTracker.failSubTask(msg.taskId, msg.uniqFileName);
  }
}
```
