import { z } from "zod";

export const VERSION = "0.1.0";
/** Increment when operations are added or removed, or their inputs, replies, capabilities or meaning break compatibility. */
export const API_VERSION = 2;
export const API_VERSION_HEADER = "x-mainworthy-api-version";
/** When a write to a demo project happened, in milliseconds since 1970 (decision 0100); only a demo project takes it. */
export const AT_HEADER = "x-mainworthy-at";
export const ApiHealth = z.object({ ok: z.literal(true), apiVersion: z.number().int().positive() });
