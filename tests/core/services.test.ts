import { TaskService } from '../../src/core/services/task-service';
import { TaskState } from '../../src/core/models';

describe('Task Service', () => {
  let taskService: TaskService;

  beforeEach(() => {
    taskService = new TaskService();
  });

  it('should create and retrieve tasks', () => {
    const config = {
      id: '1',
      name: 'Test Task'
    };

    const task = taskService.createTask(config);
    const retrieved = taskService.getTask('1');

    expect(task.id).toBe('1');
    expect(retrieved?.id).toBe('1');
  });

  it('should update tasks', () => {
    const config = {
      id: '2',
      name: 'Update Test'
    };

    const task = taskService.createTask(config);
    taskService.updateTask('2', { state: TaskState.QUEUED });

    expect(task.state).toBe(TaskState.QUEUED);
  });

  it('should transition tasks correctly', () => {
    const config = {
      id: '3',
      name: 'Transition Test'
    };

    const task = taskService.createTask(config);
    taskService.transitionToQueued('3');

    expect(task.state).toBe(TaskState.QUEUED);

    taskService.transitionToRunning('3');
    expect(task.state).toBe(TaskState.RUNNING);
  });
});
