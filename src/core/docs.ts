// The user documentation's table of contents: which pages exist, in which order, and where each one is served.
// The pages are the Markdown files in `docs/guide/`; the server renders them at `/docs` (`src/surfaces/docs/`).
// It is here, in the core, because the web UI links to these pages and the server serves them: both read one list,
// so a link in the app cannot name a page the site does not have.

const SECTIONS = [
	{
		title: "Start",
		pages: [
			{ slug: "index", title: "Mainworthy documentation" },
			{ slug: "concepts", title: "How Mainworthy works" },
			{ slug: "quickstart", title: "Quickstart" },
		],
	},
	{
		title: "Use it",
		pages: [
			{ slug: "write-cases", title: "Write cases" },
			{ slug: "report-results", title: "Report results" },
			{ slug: "decide", title: "Decide in the queue" },
			{ slug: "runs", title: "Planned runs" },
			{ slug: "changes", title: "Changes and the gate" },
			{ slug: "agents", title: "Let an agent in" },
			{ slug: "iphone", title: "The iPhone app" },
		],
	},
	{
		title: "Customize",
		pages: [
			{ slug: "customize", title: "What you can customize" },
			{ slug: "policy", title: "Policy" },
			{ slug: "access", title: "People, agents and pipelines" },
			{ slug: "configuration", title: "Configuration" },
			{ slug: "data", title: "Your data" },
			{ slug: "privacy", title: "Privacy" },
		],
	},
	{
		title: "Reference",
		pages: [
			{ slug: "keyboard", title: "Keyboard" },
			{ slug: "cli", title: "Command line" },
			{ slug: "api", title: "API and agent tools" },
			{ slug: "glossary", title: "Glossary" },
			{ slug: "troubleshooting", title: "Troubleshooting" },
			{ slug: "architecture", title: "How it is built" },
			{ slug: "licence", title: "Licence" },
		],
	},
] as const;

export type DocSlug = (typeof SECTIONS)[number]["pages"][number]["slug"];
export type DocPage = { slug: DocSlug; title: string; section: string };

export const DOC_SECTIONS: readonly { title: string; pages: readonly DocPage[] }[] = SECTIONS.map((section) => ({
	title: section.title,
	pages: section.pages.map((page) => ({ ...page, section: section.title })),
}));

/** Every page, in reading order. */
export const DOC_PAGES: readonly DocPage[] = DOC_SECTIONS.flatMap((section) => section.pages);

export const isDocSlug = (value: string): value is DocSlug => DOC_PAGES.some((page) => page.slug === value);

/** Where the site is served. It needs no session, so the link works from the sign-in page too. */
export const DOCS_ROOT = "/docs";

/** The address of a page, and of a heading on it when `anchor` is given. */
export function docUrl(slug: DocSlug = "index", anchor?: string): string {
	return `${slug === "index" ? DOCS_ROOT : `${DOCS_ROOT}/${slug}`}${anchor ? `#${anchor}` : ""}`;
}

/**
 * The page that explains each screen of the web UI: where "Docs for this screen" goes. The web UI checks that
 * every screen it has is named here.
 */
export const SCREEN_DOCS = {
	suite: "write-cases",
	case: "write-cases",
	queue: "decide",
	runs: "runs",
	changes: "changes",
	settings: "customize",
} as const satisfies Record<string, DocSlug>;

/**
 * The licence files at the root of the repository, which the site serves as they are: Mainworthy's licence, its
 * copyright notice, and the licences of what it bundles from others. A page links one as `../../NAME`, which is
 * the file on GitHub too.
 */
export const LICENCE_FILES = ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"] as const;
export type LicenceFile = (typeof LICENCE_FILES)[number];

export const licenceFileUrl = (name: LicenceFile): string => `${DOCS_ROOT}/licence/${name}`;
