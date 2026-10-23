// The startup listener stays responsive while SQLite copies and migrates on this thread.
import { workerData } from "node:worker_threads";
import { openDatabase } from "./migrate.ts";

const path: unknown = workerData;
if (typeof path !== "string") throw new Error("an upgrade worker needs its database path");
openDatabase(path).close();
