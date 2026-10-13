// Text assets bundled into the server (and into the single-file build).
declare module "*.sql" {
	const text: string;
	export default text;
}
declare module "*.md" {
	const text: string;
	export default text;
}
declare module "*.html" {
	const page: unknown;
	export default page;
}
declare module "*.svg" {
	const page: unknown;
	export default page;
}
// Imported with `type: "file"`: the value is where the file is, on disk or inside the single-file build.
declare module "*.png" {
	const path: string;
	export default path;
}
