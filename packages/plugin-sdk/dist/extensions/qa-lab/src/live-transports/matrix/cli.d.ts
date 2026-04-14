import type { Command } from "commander";
import { type LiveTransportQaCliRegistration } from "../shared/live-transport-cli.js";
export declare const matrixQaCliRegistration: LiveTransportQaCliRegistration;
export declare function registerMatrixQaCli(qa: Command): void;
