const debug = require('debug')('FastMutex');

export type Stats = {
  restartCount: number;
  locksLost: number;
  contentionCount: number;
  acquireDuration: number;
  acquireStart: null | number;
  acquireEnd: null | number;
  lockStart: null | number;
  lockEnd: null | number;
  lockDuration: null | number;
};

/**
 * Helper function to create a randomId to distinguish between different
 * FastMutex clients.  localStorage uses strings, so explicitly cast to string:
 */
const randomId = () => Math.random() + '';

export default class FastMutex {
  readonly clientId: string;
  readonly xPrefix: string;
  readonly yPrefix: string;
  readonly timeout: number;
  readonly localStorage: Storage;

  lockStats: Stats;

  constructor({
    clientId = randomId(),
    xPrefix = '_MUTEX_LOCK_X_',
    yPrefix = '_MUTEX_LOCK_Y_',
    timeout = 5000,
    localStorage = window.localStorage,
  } = {}) {
    this.clientId = clientId;
    this.xPrefix = xPrefix;
    this.yPrefix = yPrefix;
    this.timeout = timeout;
    this.localStorage = localStorage;

    this.lockStats = emptyStats();
  }

  lock(key: string) {
    debug('Attempting to acquire Lock on "%s" using FastMutex instance "%s"', key, this.clientId);
    const x = this.xPrefix + key;
    const y = this.yPrefix + key;
    this.resetStats();

    this.lockStats.acquireStart = +new Date();

    return new Promise<Stats>((resolve, reject) => {
      /**
       * Helper function to calculate the endTime, lock acquisition time, and then
       * resolve the promise with all the lock stats
       */
      const resolveWithStats = () => {
        const currentTime = +new Date();
        this.lockStats.acquireEnd = currentTime;
        this.lockStats.acquireDuration = this.lockStats.acquireEnd - this.lockStats.acquireStart!;
        this.lockStats.lockStart = currentTime;
        resolve(this.lockStats);
      };

      // we need to differentiate between API calls to lock() and our internal
      // recursive calls so that we can timeout based on the original lock() and
      // not each subsequent call.  Therefore, create a new function here within
      // the promise closure that we use for subsequent calls:
      const acquireLock = (key: string) => {
        const elapsedTime = +new Date() - this.lockStats.acquireStart!;
        if (elapsedTime >= this.timeout) {
          debug(
            'Lock on "%s" could not be acquired within %sms by FastMutex client "%s"',
            key,
            this.timeout,
            this.clientId
          );
          return reject(new Error(`Lock could not be acquired within ${this.timeout}ms`));
        }

        this.setItem(x, this.clientId);

        // if y exists, another client is getting a lock, so retry in a bit
        let lsY = this.getItem(y);
        if (lsY) {
          debug('Lock exists on Y (%s), restarting...', lsY);
          this.lockStats.restartCount++;
          setTimeout(() => acquireLock(key));
          return;
        }

        // ask for inner lock
        this.setItem(y, this.clientId);

        // if x was changed, another client is contending for an inner lock
        let lsX = this.getItem(x);
        if (lsX !== this.clientId) {
          this.lockStats.contentionCount++;
          debug('Lock contention detected. X="%s"', lsX);

          // Give enough time for critical section:
          setTimeout(() => {
            lsY = this.getItem(y);
            if (lsY === this.clientId) {
              // we have a lock
              debug('FastMutex client "%s" won the lock contention on "%s"', this.clientId, key);
              resolveWithStats();
            } else {
              // we lost the lock, restart the process again
              this.lockStats.restartCount++;
              this.lockStats.locksLost++;
              debug(
                'FastMutex client "%s" lost the lock contention on "%s" to another process (%s). Restarting...',
                this.clientId,
                key,
                lsY
              );
              setTimeout(() => acquireLock(key));
            }
          }, 50);
          return;
        }

        // no contention:
        debug('FastMutex client "%s" acquired a lock on "%s" with no contention', this.clientId, key);
        resolveWithStats();
      };

      acquireLock(key);
    });
  }

  release(key: string) {
    debug('FastMutex client "%s" is releasing lock on "%s"', this.clientId, key);
    const y = this.yPrefix + key;
    return new Promise((resolve) => {
      this.localStorage.removeItem(y);
      this.lockStats.lockEnd = +new Date();
      this.lockStats.lockDuration = this.lockStats.lockEnd - this.lockStats.lockStart!;
      resolve(this.lockStats);
      this.resetStats();
    });
  }

  /**
   * Helper function to wrap all values in an object that includes the time (so
   * that we can expire it in the future) and json.stringify's it
   */
  setItem<T>(key: string, value: T) {
    return this.localStorage.setItem(
      key,
      JSON.stringify({
        expiresAt: +new Date() + this.timeout,
        value,
      })
    );
  }

  /**
   * Helper function to parse JSON encoded values set in localStorage
   */
  getItem<T>(key: string): T | null {
    const item = this.localStorage.getItem(key);
    if (!item) return null;

    const parsed = JSON.parse(item);
    if (+new Date() - parsed.expiresAt >= this.timeout) {
      debug('FastMutex client "%s" removed an expired record on "%s"', this.clientId, key);
      this.localStorage.removeItem(key);
      return null;
    }

    return JSON.parse(item).value;
  }

  /**
   * Helper function to reset statistics. A single FastMutex client can be used
   * to perform multiple successive lock()s so we need to reset stats each time
   */
  resetStats() {
    this.lockStats = emptyStats();
  }
}

const emptyStats = (): Stats => {
  return {
    restartCount: 0,
    locksLost: 0,
    contentionCount: 0,
    acquireDuration: 0,
    acquireStart: null,
    acquireEnd: null,
    lockStart: null,
    lockEnd: null,
    lockDuration: null,
  };
};
