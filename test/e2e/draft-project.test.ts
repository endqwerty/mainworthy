import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { start } from "../../src/app/start.ts";
import type { Api, OpName } from "../../src/core/api.ts";
import { CaseBody } from "../../src/core/model.ts";
import { defaultConfig } from "../../src/server/kernel/app.ts";
import { removeProject } from "../../src/server/transfer/transfer.ts";
import ui from "../../src/web/index.html";
import { call } from "../../src/web/lib/api.ts";
import { Draft } from "../../src/web/lib/drafts.ts";
import { browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

for (const stage of ["waiting for review", "before its first merge"] as const)
	test.skipIf(!browserAvailable)(
		`a restored conflict ${stage} cannot follow a replacement project's question`,
		async () => {
			const dataDir = await mkdtemp(join(tmpdir(), "mainworthy-draft-state-project-"));
			const token = "draft-state-project-owner-token";
			const instance = await start(
				{ ...defaultConfig({}), dataDir, port: 0, owner: "robin", ownerToken: token, mode: "local" },
