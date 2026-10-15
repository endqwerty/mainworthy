import type { z } from "zod";
import type { Api, OpName } from "../core/api.ts";
import { REPLIES } from "../core/replies.ts";

export const REPLY_SCHEMAS: { [N in OpName]: z.ZodType<Api[N]["reply"]> } = REPLIES;
