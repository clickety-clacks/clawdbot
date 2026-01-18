export {
  enableConsoleCapture,
  getConsoleSettings,
  getResolvedConsoleSettings,
  routeLogsToStderr,
  setConsoleSubsystemFilter,
  setConsoleTimestampPrefix,
  shouldLogSubsystemToConsole,
  type ConsoleLoggerSettings,
  type ConsoleStyle,
} from "./logging/console.js";
export type { LogLevel } from "./logging/levels.js";
export {
  DEFAULT_LOG_DIR,
  DEFAULT_LOG_FILE,
  getChildLogger,
  getLogger,
  getResolvedLoggerSettings,
  isFileLogLevelEnabled,
  resetLogger,
  setLoggerOverride,
  toPinoLikeLogger,
  type LoggerResolvedSettings,
  type LoggerSettings,
  type PinoLikeLogger,
} from "./logging/logger.js";
export {
  createSubsystemLogger,
  runtimeForLogger,
  stripRedundantSubsystemPrefixForConsole,
  type SubsystemLogger,
} from "./logging/subsystem.js";
