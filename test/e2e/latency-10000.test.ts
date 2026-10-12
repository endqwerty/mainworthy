// One size of suite per file, so the two do not add up in one worker. The measurement: `latency.ts`.
import { latency } from "./latency.ts";

latency(10000);
