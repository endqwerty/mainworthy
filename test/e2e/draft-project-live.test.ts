import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../src/app/start.ts";
import type { Api, OpName } from "../../src/core/api.ts";
import { defaultConfig } from "../../src/server/kernel/app.ts";
import { removeProject } from "../../src/server/transfer/transfer.ts";
import ui from "../../src/web/index.html";
import { call } from "../../src/web/lib/api.ts";
import { Draft } from "../../src/web/lib/drafts.ts";
import { browserAvailable, openPage, type Server } from "./support.ts";

test.skipIf(!browserAvailable)(
	"an open tab preserves a waiting capture when its project is replaced and its question collides",
	async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mainworthy-draft-project-live-"));
		const token = "draft-project-live-owner-token";
		const instance = await start(
			{ ...defaultConfig({}), dataDir, port: 0, owner: "robin", ownerToken: token, mode: "local" },
