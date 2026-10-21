import { redact, scrubString } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

export type Logger = {
  child(fields: LogFields): Logger;
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
};

export function createLogger(options: {
  level: LogLevel;
  base?: LogFields;
  secrets?: readonly string[];
  stream?: NodeJS.WritableStream;
}): Logger {
  const stream = options.stream ?? process.stdout;
  const secrets = options.secrets ?? [];
  const base = options.base ?? {};

  const write = (level: LogLevel, fields: LogFields, message: string): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[options.level]) {
      return;
    }
    const payload = redact({ ...base, ...fields }, secrets);
    const line = {
      time: new Date().toISOString(),
      level,
      message: scrubString(message, secrets),
      ...(typeof payload === "object" && payload !== null ? payload : {}),
    };
    stream.write(`${JSON.stringify(line)}\n`);
  };

  const logger: Logger = {
    child(fields: LogFields): Logger {
      const merged = redact({ ...base, ...fields }, secrets);
      return createLogger({
        level: options.level,
        base: typeof merged === "object" && merged !== null ? (merged as LogFields) : {},
        secrets,
        stream,
      });
    },
    debug: (fields, message) => write("debug", fields, message),
    info: (fields, message) => write("info", fields, message),
    warn: (fields, message) => write("warn", fields, message),
    error: (fields, message) => write("error", fields, message),
  };
  return logger;
}
