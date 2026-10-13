// What the documentation site is made of: every page, diagram and screenshot, imported by name so that the
// single-file build carries them. A page added to `docs/guide/` is added here and to the table of contents in
// `src/core/docs.ts`; `test/docs.test.ts` fails on a file that is in one place and not the other.
import agentAccess from "../../../docs/diagrams/agent-access.html" with { type: "text" };
import architectureDiagram from "../../../docs/diagrams/architecture.html" with { type: "text" };
import caseLifecycle from "../../../docs/diagrams/case-lifecycle.html" with { type: "text" };
import customizeMap from "../../../docs/diagrams/customize-map.html" with { type: "text" };
import gateVerdict from "../../../docs/diagrams/gate-verdict.html" with { type: "text" };
import overview from "../../../docs/diagrams/overview.html" with { type: "text" };
import plannedRun from "../../../docs/diagrams/planned-run.html" with { type: "text" };
import policyRouting from "../../../docs/diagrams/policy-routing.html" with { type: "text" };
import questionLifecycle from "../../../docs/diagrams/question-lifecycle.html" with { type: "text" };
import redBuild from "../../../docs/diagrams/red-build.html" with { type: "text" };
import access from "../../../docs/guide/access.md" with { type: "text" };
import agents from "../../../docs/guide/agents.md" with { type: "text" };
import api from "../../../docs/guide/api.md" with { type: "text" };
import architecture from "../../../docs/guide/architecture.md" with { type: "text" };
import changes from "../../../docs/guide/changes.md" with { type: "text" };
import cli from "../../../docs/guide/cli.md" with { type: "text" };
import concepts from "../../../docs/guide/concepts.md" with { type: "text" };
import configuration from "../../../docs/guide/configuration.md" with { type: "text" };
import customize from "../../../docs/guide/customize.md" with { type: "text" };
import data from "../../../docs/guide/data.md" with { type: "text" };
import decide from "../../../docs/guide/decide.md" with { type: "text" };
import glossary from "../../../docs/guide/glossary.md" with { type: "text" };
import index from "../../../docs/guide/index.md" with { type: "text" };
import keyboard from "../../../docs/guide/keyboard.md" with { type: "text" };
import policy from "../../../docs/guide/policy.md" with { type: "text" };
import quickstart from "../../../docs/guide/quickstart.md" with { type: "text" };
import reportResults from "../../../docs/guide/report-results.md" with { type: "text" };
import runs from "../../../docs/guide/runs.md" with { type: "text" };
import troubleshooting from "../../../docs/guide/troubleshooting.md" with { type: "text" };
import writeCases from "../../../docs/guide/write-cases.md" with { type: "text" };
import caseDark from "../../../docs/ui/screenshots/case-dark.png" with { type: "file" };
import caseLight from "../../../docs/ui/screenshots/case-light.png" with { type: "file" };
import changesDark from "../../../docs/ui/screenshots/changes-dark.png" with { type: "file" };
import changesLight from "../../../docs/ui/screenshots/changes-light.png" with { type: "file" };
import queueDark from "../../../docs/ui/screenshots/queue-dark.png" with { type: "file" };
import queueLight from "../../../docs/ui/screenshots/queue-light.png" with { type: "file" };
import runsDark from "../../../docs/ui/screenshots/runs-dark.png" with { type: "file" };
import runsLight from "../../../docs/ui/screenshots/runs-light.png" with { type: "file" };
import settingsDark from "../../../docs/ui/screenshots/settings-dark.png" with { type: "file" };
import settingsLight from "../../../docs/ui/screenshots/settings-light.png" with { type: "file" };
import suiteDark from "../../../docs/ui/screenshots/suite-dark.png" with { type: "file" };
import suiteLight from "../../../docs/ui/screenshots/suite-light.png" with { type: "file" };
import type { DocSlug } from "../../core/docs.ts";
import icon from "../../web/icon.svg" with { type: "text" };
import script from "./client.js" with { type: "text" };
import styles from "./site.css" with { type: "text" };

/** An import with `type: "text"` is a string whatever its extension is declared as; this is where that is checked. */
function text(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`the documentation's ${name} was not bundled as text`);
	return value;
}

/** The Markdown of every page in the table of contents. The type makes a page without a file a compile error. */
export const PAGES: Readonly<Record<DocSlug, string>> = {
	index,
	concepts,
	quickstart,
	"write-cases": writeCases,
	"report-results": reportResults,
	decide,
	runs,
	changes,
	agents,
	customize,
	policy,
	access,
	configuration,
	data,
	keyboard,
	cli,
	api,
	glossary,
	troubleshooting,
	architecture,
};

/** The interactive diagrams, by the name a page links (`../diagrams/<name>.html`). Each is one self-contained page. */
export const DIAGRAMS: Readonly<Record<string, string>> = {
	"agent-access": text(agentAccess, "diagram agent-access"),
	architecture: text(architectureDiagram, "diagram architecture"),
	"case-lifecycle": text(caseLifecycle, "diagram case-lifecycle"),
	"customize-map": text(customizeMap, "diagram customize-map"),
	"gate-verdict": text(gateVerdict, "diagram gate-verdict"),
	overview: text(overview, "diagram overview"),
	"planned-run": text(plannedRun, "diagram planned-run"),
	"policy-routing": text(policyRouting, "diagram policy-routing"),
	"question-lifecycle": text(questionLifecycle, "diagram question-lifecycle"),
	"red-build": text(redBuild, "diagram red-build"),
};

/** The screenshots, by file name without `.png`. The value is where the file is: on disk, or inside the executable. */
export const SCREENSHOTS: Readonly<Record<string, string>> = {
	"case-dark": caseDark,
	"case-light": caseLight,
	"changes-dark": changesDark,
	"changes-light": changesLight,
	"queue-dark": queueDark,
	"queue-light": queueLight,
	"runs-dark": runsDark,
	"runs-light": runsLight,
	"settings-dark": settingsDark,
	"settings-light": settingsLight,
	"suite-dark": suiteDark,
	"suite-light": suiteLight,
};

export const STYLES: string = text(styles, "style sheet");
export const SCRIPT: string = text(script, "script");
export const ICON: string = text(icon, "icon");
