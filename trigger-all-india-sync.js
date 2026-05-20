/*
 * Trigger all-India hotel sync via API.
 *
 * Usage:
 *   node trigger-all-india-sync.js
 *   node trigger-all-india-sync.js --baseUrl=http://localhost:4006/api/v1 --email=admin@dvi.co.in --password=Keerthi@2404ias
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const axios = require('axios');
const { URL } = require('url');

const PROGRESS_REGEX = /Starting full India sync using CityList API|CityList API returned|Starting hotel master sync for TBO city code|Fetched\s+\d+\s+hotels from TBO for city|Successfully synced\s+\d+\/\d+\s+hotels for city|Hotel sync failed/i;
const CITY_START_REGEX = /Starting hotel master sync for TBO city code:\s*([0-9]+)/i;
const CITY_FETCHED_REGEX = /Fetched\s+(\d+)\s+hotels from TBO for city\s+([0-9]+)/i;
const CITY_SUCCESS_REGEX = /Successfully synced\s+(\d+)\/(\d+)\s+hotels for city\s+([0-9]+)/i;

function parseArgs(argv) {
  const out = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq === -1) {
      out[item.slice(2)] = 'true';
      continue;
    }
    out[item.slice(2, eq)] = item.slice(eq + 1);
  }
  return out;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function toBool(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function getLatestServerLogFile(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^server-logs-live.*\.txt$/i.test(name))
    .map((name) => ({
      name,
      fullPath: path.join(dir, name),
      mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files.length ? files[0].fullPath : null;
}

function startProgressWatcher(logFilePath) {
  const counters = {
    startedCities: new Set(),
    successCities: new Set(),
    failedCities: new Set(),
    totalFetchedHotels: 0,
    totalInsertedHotels: 0,
  };

  let position = 0;
  let carry = '';

  if (fs.existsSync(logFilePath)) {
    position = fs.statSync(logFilePath).size;
  }

  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(logFilePath)) return;

      const stat = fs.statSync(logFilePath);
      if (stat.size < position) {
        position = 0;
        carry = '';
      }
      if (stat.size === position) return;

      const readLen = stat.size - position;
      const fd = fs.openSync(logFilePath, 'r');
      const buffer = Buffer.alloc(readLen);
      fs.readSync(fd, buffer, 0, readLen, position);
      fs.closeSync(fd);
      position = stat.size;

      const text = carry + buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      carry = lines.pop() || '';

      for (const line of lines) {
        if (PROGRESS_REGEX.test(line)) {
          const trimmed = line.trim();

          const startMatch = trimmed.match(CITY_START_REGEX);
          if (startMatch) {
            counters.startedCities.add(startMatch[1]);
          }

          const fetchedMatch = trimmed.match(CITY_FETCHED_REGEX);
          if (fetchedMatch) {
            counters.totalFetchedHotels += Number(fetchedMatch[1]) || 0;
          }

          const successMatch = trimmed.match(CITY_SUCCESS_REGEX);
          if (successMatch) {
            const inserted = Number(successMatch[1]) || 0;
            const cityCode = successMatch[3];
            counters.totalInsertedHotels += inserted;
            counters.successCities.add(cityCode);
            counters.failedCities.delete(cityCode);
          }

          if (/Hotel sync failed/i.test(trimmed)) {
            counters.failedCities.add(`fail-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`);
          }

          console.log(`[SYNC] ${trimmed}`);
          console.log(
            `[SYNC-COUNTER] started=${counters.startedCities.size} success=${counters.successCities.size} failed=${counters.failedCities.size} fetched=${counters.totalFetchedHotels} inserted=${counters.totalInsertedHotels}`,
          );
        }
      }
    } catch (error) {
      // Keep watcher resilient during long runs.
    }
  }, 1200);

  return {
    stop: () => clearInterval(timer),
    getSnapshot: () => ({
      startedCities: counters.startedCities.size,
      successCities: counters.successCities.size,
      failedCities: counters.failedCities.size,
      totalFetchedHotels: counters.totalFetchedHotels,
      totalInsertedHotels: counters.totalInsertedHotels,
    }),
  };
}

async function assertServerReachable(baseUrl) {
  const parsedUrl = new URL(baseUrl);
  const port = Number(parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80));

  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: parsedUrl.hostname, port });
    let settled = false;

    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };

    socket.setTimeout(4000);
    socket.once('connect', finish(resolve));
    socket.once(
      'error',
      finish((error) => {
        const detail = error && error.message ? error.message : 'connection refused or server not running';
        reject(new Error(`Cannot reach ${parsedUrl.hostname}:${port} - ${detail}`));
      }),
    );
    socket.once(
      'timeout',
      finish(() => reject(new Error(`Cannot reach ${parsedUrl.hostname}:${port} - connection timed out`))),
    );
  });
}

function formatAxiosError(err) {
  if (!err) {
    return 'Unknown error';
  }

  if (err.response) {
    const status = err.response.status;
    const statusText = err.response.statusText || '';
    const responseData = typeof err.response.data === 'string'
      ? err.response.data
      : JSON.stringify(err.response.data);
    return `HTTP ${status} ${statusText}`.trim() + (responseData ? ` - ${responseData}` : '');
  }

  if (err.code || err.message) {
    return [err.code, err.message].filter(Boolean).join(' - ');
  }

  return String(err);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  const baseUrl = args.baseUrl || process.env.BASE_URL || 'http://localhost:4006/api/v1';
  const email = args.email || process.env.SYNC_EMAIL || 'admin@dvi.co.in';
  const password = args.password || process.env.SYNC_PASSWORD || 'Keerthi@2404ias';
  const watchLogs = toBool(args.watchLogs || process.env.SYNC_WATCH_LOGS, true);
  const explicitLogFile = args.logFile ? path.resolve(process.cwd(), args.logFile) : null;

  const ts = nowStamp();
  const outDir = __dirname;
  const resultPath = path.join(outDir, `sync-all-india-result-${ts}.json`);
  const logPath = path.join(outDir, `sync-all-india-trigger-${ts}.log`);

  const log = [];
  const pushLog = (line) => {
    log.push(line);
    fs.writeFileSync(logPath, log.join('\n'), 'utf8');
  };

  pushLog(`START=${new Date().toISOString()}`);
  pushLog(`BASE_URL=${baseUrl}`);

  let watcher = null;

  try {
    await assertServerReachable(baseUrl);

    const loginResp = await axios.post(
      `${baseUrl}/auth/login`,
      { email, password },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const token = loginResp.data && loginResp.data.accessToken;
    if (!token) {
      throw new Error('Login succeeded but no accessToken returned');
    }

    pushLog(`SYNC_REQUEST_START=${new Date().toISOString()}`);

    if (watchLogs) {
      const serverLogFile = explicitLogFile || getLatestServerLogFile(outDir);
      if (serverLogFile) {
        pushLog(`WATCH_LOG_FILE=${serverLogFile}`);
        console.log(`Watching sync logs from: ${serverLogFile}`);
        watcher = startProgressWatcher(serverLogFile);
      } else {
        console.log('No server log file found to watch (server-logs-live*.txt).');
      }
    }

    console.log('Sync request sent. Waiting for completion...');

    const syncResp = await axios.post(
      `${baseUrl}/hotels/sync/all-india`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 0,
      }
    );

    pushLog(`SYNC_REQUEST_END=${new Date().toISOString()}`);

    if (watcher) {
      watcher.stop();
      const snapshot = watcher.getSnapshot();
      console.log(
        `Final counter: started=${snapshot.startedCities} success=${snapshot.successCities} failed=${snapshot.failedCities} fetched=${snapshot.totalFetchedHotels} inserted=${snapshot.totalInsertedHotels}`,
      );
      watcher = null;
    }

    fs.writeFileSync(resultPath, JSON.stringify(syncResp.data, null, 2), 'utf8');
    pushLog(`RESULT_FILE=${resultPath}`);
    pushLog('STATUS=SUCCESS');

    console.log('Sync completed.');
    console.log(`Result: ${resultPath}`);
    console.log(`Log:    ${logPath}`);
  } catch (err) {
    if (watcher) {
      watcher.stop();
      const snapshot = watcher.getSnapshot();
      console.log(
        `Final counter: started=${snapshot.startedCities} success=${snapshot.successCities} failed=${snapshot.failedCities} fetched=${snapshot.totalFetchedHotels} inserted=${snapshot.totalInsertedHotels}`,
      );
      watcher = null;
    }

    const msg = formatAxiosError(err);

    pushLog('STATUS=FAILED');
    pushLog(`ERROR=${msg}`);

    console.error(msg);
    process.exitCode = 1;
  }
}

run();
