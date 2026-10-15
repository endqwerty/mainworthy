// The licence files at the root of the repository have no extension, so TypeScript cannot tell from the name what
// an import of one is. `content.ts` imports them `with { type: "text" }`, and Bun hands it the text.
declare module "*/LICENSE" {
	const text: string;
	export default text;
}
declare module "*/NOTICE" {
	const text: string;
	export default text;
}
