export class SessionLock {
  constructor() {
    this.tails = new Map();
  }

  async run(key, operation) {
    const release = await this.acquire(key);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async acquire(key) {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let unlock;
    const current = new Promise((resolve) => { unlock = resolve; });
    this.tails.set(key, current);
    await previous;
    return () => {
      unlock();
      if (this.tails.get(key) === current) this.tails.delete(key);
    };
  }
}
