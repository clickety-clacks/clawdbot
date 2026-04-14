import type { Command } from "commander";
import { type LiveTransportQaCliRegistration } from "../shared/live-transport-cli.js";
export declare const telegramQaCliRegistration: LiveTransportQaCliRegistration;
export declare function registerTelegramQaCli(qa: Command): void;
