// utils/logger.js
export const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const cfgLevel = process.env.LOG_LEVEL || "info";
const cur = levels[cfgLevel] ?? levels.info;

function ts() { return new Date().toISOString(); }

export const log = {
  debug: (...args) => { if (cur <= levels.debug) console.log(ts(), "[DEBUG]", ...args); },
  info:  (...args) => { if (cur <= levels.info)  console.log(ts(), "[INFO]", ...args); },
  warn:  (...args) => { if (cur <= levels.warn)  console.warn(ts(), "[WARN]", ...args); },
  error: (...args) => { if (cur <= levels.error) console.error(ts(), "[ERROR]", ...args); }
};