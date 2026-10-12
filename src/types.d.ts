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
