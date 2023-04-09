import test from 'ava';
import * as td from 'testdouble';
import { Quota, QuotaManager } from '../src';
import { pRateLimit } from '../src/rateLimit';
import { RateLimitTimeoutError } from '../src/rateLimitTimeoutError';
import { sleep } from '../src/util';

function mockApi(sleepTime: number) {
  const fn = async (err: Error = null): Promise<void> => {
    fn['runCount']++;
    if (err) {
      fn['rejectCount']++;
      throw err;
    }
    await sleep(sleepTime);
    fn['fulfillCount']++;
  };

  fn['runCount'] = 0;
  fn['rejectCount'] = 0;
  fn['fulfillCount'] = 0;

  return fn;
}

test('can construct from a Quota object', async t => {
  const quota: Quota = { concurrency: 2 };
  const rateLimit = pRateLimit(quota);
  t.truthy(rateLimit);
});

test('can construct from a QuotaManager object', async t => {
  const quota: Quota = { concurrency: 2 };
  const qm = new QuotaManager(quota);
  const rateLimit = pRateLimit(qm);
  t.truthy(rateLimit);
});

test('concurrency is enforced', async t => {
  const quota: Quota = { concurrency: 2 };
  const rateLimit = pRateLimit(quota);

  const api = mockApi(500);

  const startTime = Date.now();

  const promises = [
    rateLimit(() => api()), // 0-500 ms
    rateLimit(() => api()), // 0-500 ms
    rateLimit(() => api()) // 500-1000 ms
  ];

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed < 500) {
      t.is(api['fulfillCount'], 0, 'at t < 500, 0 jobs are done');
    } else if (elapsed > 600 && elapsed < 900) {
      t.is(api['fulfillCount'], 2, 'at 500 < t < 1000, 2 jobs are done');
    } else if (elapsed > 1200) {
      t.is(api['fulfillCount'], 3, 'at t > 1200, 3 jobs are done');
      break;
    }
    await sleep(200);
  }
});

test('rate limits are enforced', async t => {
  const quota: Quota = { interval: 500, rate: 3 };
  const quotaManager = new QuotaManager(quota);
  const rateLimit = pRateLimit(quotaManager);

  const api = mockApi(500);

  const startTime = Date.now();

  const promises = [
    rateLimit(() => api()), // 0-500 ms
    rateLimit(() => api()), // 0-500 ms
    rateLimit(() => api()), // 0-500 ms
    rateLimit(() => api()), // 500-1000 ms
    rateLimit(() => api()) // 500-1000 ms
  ];

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed < 500) {
      t.is(quotaManager.activeCount, 3, 'at t < 500, 3 jobs are active');
      t.is(api['fulfillCount'], 0, 'at t < 500, 0 jobs are done');
    } else if (elapsed > 600 && elapsed < 900) {
      t.is(quotaManager.activeCount, 2, 'at 500 < t < 1000, 2 jobs are active');
      t.is(api['fulfillCount'], 3, 'at 500 < t < 1000, 3 jobs are done');
    } else if (elapsed > 1200) {
      t.is(quotaManager.activeCount, 0, 'at t > 1200, 0 jobs are active');
      t.is(api['fulfillCount'], 5, 'at t > 1200, 5 jobs are done');
      break;
    }
    await sleep(200);
  }
});

test('combined rate limits and concurrency are enforced', async t => {
  const quota: Quota = { interval: 1000, rate: 3, concurrency: 2 };
  const quotaManager = new QuotaManager(quota);
  const rateLimit = pRateLimit(quotaManager);

  const api = mockApi(500);

  const startTime = Date.now();

  const promises = [
    rateLimit(() => api()), // 0-500 ms
    rateLimit(() => api()), // 0-500 ms
    rateLimit(() => api()), // 500-1000 ms
    rateLimit(() => api()), // 1000-1500 ms
    rateLimit(() => api()) // 1000-1500 ms
  ];

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed < 500) {
      t.is(quotaManager.activeCount, 2, 'at t < 500, 2 jobs are active');
      t.is(api['fulfillCount'], 0, 'at t < 500, 0 jobs are done');
    } else if (elapsed > 600 && elapsed < 900) {
      t.is(quotaManager.activeCount, 1, 'at 500 < t < 1000, 1 job is active');
      t.is(api['fulfillCount'], 2, 'at 500 < t < 1000, 2 jobs are done');
    } else if (elapsed > 1100 && elapsed < 1400) {
      t.is(quotaManager.activeCount, 2, 'at 1000 < t < 1500, 2 jobs are active');
      t.is(api['fulfillCount'], 3, 'at 1000 < t < 1500, 3 jobs are done');
    } else if (elapsed > 1700) {
      t.is(quotaManager.activeCount, 0, 'at t > 1200, 0 jobs are active');
      t.is(api['fulfillCount'], 5, 'at t > 1200, 5 jobs are done');
      break;
    }
    await sleep(200);
  }
});

test('can handle API calls that reject', async t => {
  const quota: Quota = { interval: 500, rate: 10, concurrency: 10 };
  const rateLimit = pRateLimit(quota);

  const api = mockApi(200);

  const promises = [
    rateLimit(() => api()),
    rateLimit(() => api(new Error())),
    rateLimit(() => api()),
    rateLimit(() => api(new Error())),
    rateLimit(() => api())
  ];

  await t.throwsAsync(Promise.all(promises));

  // wait for them all to complete (rejected or not)
  await Promise.all(
    promises.map(async p => {
      try {
        await p;
      } catch {
        /* ignore */
      }
    })
  );

  t.is(api['rejectCount'], 2, '2 Promises were rejected');
  t.is(api['fulfillCount'], 3, '3 Promises were fulfilled');
});

test('API calls that wait too long are rejected', async t => {
  const quota: Quota = {
    interval: 1000,
    rate: 1,
    concurrency: 1,
    maxDelay: 500
  };
  const rateLimit = pRateLimit(quota);

  const api = mockApi(200);

  const fn1 = rateLimit(() => api());
  const fn2 = rateLimit(() => api());

  await t.notThrowsAsync(fn1);
  await t.throwsAsync(fn2, { instanceOf: RateLimitTimeoutError });
});

test('Setting maxDelay to 0 disables maxDelay rejection', async t => {
  const quota: Quota = { interval: 1000, rate: 1, concurrency: 1, maxDelay: 0 };
  const rateLimit = pRateLimit(quota);

  const api = mockApi(200);

  const fn1 = rateLimit(() => api());
  const fn2 = rateLimit(() => api());

  await t.notThrowsAsync(fn1);
  await t.notThrowsAsync(fn2);
});

test('Continues running the queue after a maxDelay timeout', async t => {
  const quota: Quota = {
    interval: 1000,
    rate: 1,
    concurrency: 1,
    maxDelay: 500
  };
  const rateLimit = pRateLimit(quota);

  const api = mockApi(200);

  const fn1 = rateLimit(() => api());
  const fn2 = rateLimit(() => api());
  const fn3 = rateLimit(() => api());

  await t.notThrowsAsync(fn1);
  await t.throwsAsync(fn2, { instanceOf: RateLimitTimeoutError });
  await t.throwsAsync(fn3, { instanceOf: RateLimitTimeoutError });
});

test.serial('Passing no quota is a no-op', async t => {
  const consoleWarn = td.replace(console, 'warn');
  try {
    // TypeScript won’t allow this but it’s possible in JavaScript
    const rateLimit = (pRateLimit as any)();

    const api = mockApi(200);

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; ++i) {
      promises.push(api());
    }

    await t.notThrowsAsync(Promise.all(promises));
  } finally {
    td.reset();
  }
});

test.serial('Passing no quota prints a console warning', async t => {
  const consoleWarn = td.replace(console, 'warn');
  try {
    // TypeScript won’t allow this but it’s possible in JavaScript
    const rateLimit = (pRateLimit as any)();

    t.notThrows(() =>
      td.verify(consoleWarn(td.matchers.contains('created with no quota')))
    );
  } finally {
    td.reset();
  }
});

test('Using an empty quota is a no-op', async t => {
  const quota: Quota = {};
  const rateLimit = pRateLimit(quota);

  const api = mockApi(200);

  const promises: Promise<void>[] = [];
  for (let i = 0; i < 100; ++i) {
    promises.push(api());
  }

  await t.notThrowsAsync(Promise.all(promises));
});
