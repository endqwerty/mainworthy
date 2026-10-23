// Bootstrap and recovery can scan all stored evidence. Keep the health listener on the parent thread.
import { parentPort, workerData } from "node:worker_threads";
import { prepareStartup, type StartupData, startupConfig } from "./start.ts";

if (!parentPort) throw new Error("startup needs its parent thread");
const port = parentPort;
const data: StartupData = workerData;
const progress = () => port.postMessage({ kind: "progress" });
const prepared = prepareStartup(
	startupConfig(data),
	{
		copyWorkspace: data.workspace,
		...(data.firstProject === undefined ? {} : { firstProject: data.firstProject }),
		...(data.now === undefined ? {} : { now: () => data.now ?? Date.now() }),
	},
	progress,
);
port.postMessage({ kind: "prepared", prepared });
