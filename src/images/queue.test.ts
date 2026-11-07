import { describe, expect, it } from 'vitest';
import { TaskQueue } from './queue';

/** A task that runs until its finish() is called, recording when it starts. */
function controlled(log: string[], name: string) {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const task = async () => {
    log.push(`start ${name}`);
    await done;
    log.push(`end ${name}`);
    return name;
  };
  return { task, finish };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TaskQueue', () => {
  it('runs at most `limit` tasks at once and starts the rest in order', async () => {
    const queue = new TaskQueue(2);
    const log: string[] = [];
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => controlled(log, n));
    const results = [a, b, c, d].map((t) => queue.run(t.task));
    await tick();
    expect(log).toEqual(['start a', 'start b']);
    expect(queue.running).toBe(2);
    expect(queue.queued).toBe(2);

    b.finish();
    await tick();
    expect(log).toEqual(['start a', 'start b', 'end b', 'start c']);
    expect(queue.running).toBe(2);

    a.finish();
    c.finish();
    d.finish();
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd']);
    expect(queue.running).toBe(0);
  });

  it('never lets a newcomer slip in when a slot is handed on', async () => {
    const queue = new TaskQueue(1);
    const log: string[] = [];
    const a = controlled(log, 'a');
    const b = controlled(log, 'b');
    const c = controlled(log, 'c');
    void queue.run(a.task);
    void queue.run(b.task);
    await tick();
    a.finish();
    // Queued synchronously right after the slot was released: it must wait behind b.
    void queue.run(c.task);
    await tick();
    expect(log).toEqual(['start a', 'end a', 'start b']);
    expect(queue.running).toBe(1);
    b.finish();
    await tick();
    expect(log.at(-1)).toBe('start c');
    c.finish();
  });

  it('lets a priority task jump the queue', async () => {
    const queue = new TaskQueue(1);
    const log: string[] = [];
    const [a, b, urgent] = ['a', 'b', 'urgent'].map((n) => controlled(log, n));
    void queue.run(a.task);
    void queue.run(b.task);
    void queue.run(urgent.task, { priority: true });
    await tick();
    a.finish();
    await tick();
    expect(log).toEqual(['start a', 'end a', 'start urgent']);
    urgent.finish();
    b.finish();
  });

  it('drops a waiting task whose signal aborts, and refuses one already aborted', async () => {
    const queue = new TaskQueue(1);
    const log: string[] = [];
    const a = controlled(log, 'a');
    const b = controlled(log, 'b');
    void queue.run(a.task);
    const controller = new AbortController();
    const waiting = queue.run(b.task, { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(queue.queued).toBe(0);
    await expect(queue.run(b.task, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });

    a.finish();
    await tick();
    expect(queue.running).toBe(0);
    expect(log).toEqual(['start a', 'end a']);
  });

  it('frees the slot when a task fails', async () => {
    const queue = new TaskQueue(1);
    await expect(queue.run(async () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
    expect(await queue.run(async () => 'next')).toBe('next');
  });
});
