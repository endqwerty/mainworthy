// The page runs under a policy that refuses code built from a string (`script-src 'self'`, in
// `src/surfaces/headers.ts`). zod builds such code to compile its object parsers, and first tries
// `new Function("")` to find out whether it may. It catches the refusal and parses without compiling, but the
// browser has by then reported a refused script, in the console and to anything that listens for one. Told
// beforehand, zod does not try. `main.tsx` imports this before any module that parses with zod.
import { z } from "zod";

z.config({ jitless: true });
