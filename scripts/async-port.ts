/** PostgreSQL async conversion. Plan first; refuse changes that need a human decision. */
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import {
	API,
	type Checker,
	type Symbol as CompilerSymbol,
	SignatureKind,
	SymbolFlags,
	type Type,
	TypeFlags,
} from "typescript/unstable/async";
import { z } from "zod";

const seedSchema = z.array(z.object({ file: z.string(), name: z.string(), write: z.boolean().default(false) }));
export type Seed = z.infer<typeof seedSchema>[number];
export type RefusalKind =
	| "array-callback"
	| "boolean-position"
	| "constructor-accessor-field"
	| "sync-callback"
	| "reader-scope"
	| "returning-id"
	| "unresolved-call"
	| "external-contract"
	| "generator-use"
	| "legacy-db-type";
export type Diagnostic = { file: string; line: number; column: number; kind: RefusalKind; message: string };
type Splice = { start: number; end: number; text: string };
type FunctionNode = ts.SignatureDeclaration;
type Colour = { async: boolean; generator: boolean; writes: boolean };
type FunctionInfo = { node: FunctionNode; colour: Colour; links: Set<FunctionInfo>; blocked: boolean };
type CallInfo = {
	node: ts.CallExpression;
	owner: FunctionInfo | undefined;
	targets: FunctionInfo[];
	colour: Colour;
};
export type PortOptions = { root: string; project?: string; seeds?: Seed[]; files?: string[] };
export type PortPlan = {
	changes: { file: string; before: string; after: string }[];
	diagnostics: Diagnostic[];
	pendingCalls: { file: string; line: number; column: number }[];
	counts: {
		functionsColoured: number;
		callsAwaited: number;
		generatorsConverted: number;
		refusals: Partial<Record<RefusalKind, number>>;
	};
};
const arrays = new Set([
	"map",
	"filter",
	"some",
	"find",
	"every",
	"forEach",
	"reduce",
	"reduceRight",
	"sort",
	"flatMap",
]);
const writeMethods = new Set([
	"run",
	"afterCommit",
	"runDynamic",
	"exec",
	"transaction",
	"savepoint",
	"savepointSteps",
	"checkedBulk",
	"checkedBulkSteps",
	"deferred",
	"deferForeignKeys",
	"begin",
	"commit",
	"rollback",
	"write",
]);
const kernelMethods = new Set([
	"get",
	"one",
	"all",
	"allDynamic",
	"each",
	"catalog",
	"open",
	"close",
	"read",
	...writeMethods,
]);
const blank = (): Colour => ({ async: false, generator: false, writes: false });
const functionLike = (node: ts.Node): node is FunctionNode =>
	ts.isFunctionDeclaration(node) ||
	ts.isFunctionExpression(node) ||
	ts.isArrowFunction(node) ||
	ts.isMethodDeclaration(node) ||
	ts.isMethodSignatureDeclaration(node) ||
	ts.isCallSignatureDeclaration(node) ||
	ts.isConstructSignatureDeclaration(node) ||
	ts.isConstructorDeclaration(node) ||
	ts.isGetAccessorDeclaration(node) ||
	ts.isSetAccessorDeclaration(node) ||
	ts.isFunctionTypeNode(node);
const asyncModifier = (node: FunctionNode): boolean =>
	"modifiers" in node && !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
const generator = (node: FunctionNode): boolean => "asteriskToken" in node && !!node.asteriskToken;
const key = (node: ts.Node): string => `${node.getSourceFile().fileName}:${node.getStart()}`;
const name = (node: ts.Node): string =>
	"name" in node &&
	node.name &&
	typeof node.name === "object" &&
	"getText" in node.name &&
	typeof node.name.getText === "function"
		? String(node.name.getText())
		: "";
const walk = (node: ts.Node, visit: (node: ts.Node) => void): void => {
	visit(node);
	node.forEachChild((child) => {
		walk(child, visit);
	});
};
function enclosing(node: ts.Node): FunctionNode | undefined {
	let parent = node.parent;
	while (parent && !ts.isSourceFile(parent)) {
		if (functionLike(parent)) return parent;
		parent = parent.parent;
	}
	return undefined;
}
function unparen(node: ts.Node): ts.Node {
	while (ts.isParenthesizedExpression(node)) node = node.expression;
	return node;
}
function outerExpression(node: ts.Node): ts.Node {
	while (node.parent && ts.isParenthesizedExpression(node.parent)) node = node.parent;
	return node;
}
function arrayCallback(node: FunctionNode): boolean {
	let parent: ts.Node = node;
	while (parent.parent && ts.isParenthesizedExpression(parent.parent)) parent = parent.parent;
	return (
		ts.isCallExpression(parent.parent) &&
		ts.isPropertyAccessExpression(parent.parent.expression) &&
		arrays.has(parent.parent.expression.name.text) &&
		parent.parent.arguments.some((arg) => arg === parent)
	);
}
function unsafeBody(node: ts.Node): boolean {
	for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
		if (functionLike(parent)) {
			return (
				ts.isConstructorDeclaration(parent) ||
				ts.isGetAccessorDeclaration(parent) ||
				ts.isSetAccessorDeclaration(parent)
			);
		}
		if (ts.isPropertyDeclaration(parent)) return true;
	}
	return false;
}
function booleanPosition(node: ts.Node): boolean {
	for (let parent = node.parent; parent; node = parent, parent = parent.parent) {
		if (ts.isAwaitExpression(parent)) return false;
		if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return true;
		if (
			ts.isBinaryExpression(parent) &&
			[
				ts.SyntaxKind.QuestionQuestionToken,
				ts.SyntaxKind.AmpersandAmpersandToken,
				ts.SyntaxKind.BarBarToken,
				ts.SyntaxKind.EqualsEqualsToken,
				ts.SyntaxKind.EqualsEqualsEqualsToken,
				ts.SyntaxKind.ExclamationEqualsToken,
				ts.SyntaxKind.ExclamationEqualsEqualsToken,
				ts.SyntaxKind.LessThanToken,
				ts.SyntaxKind.GreaterThanToken,
				ts.SyntaxKind.LessThanEqualsToken,
				ts.SyntaxKind.GreaterThanEqualsToken,
			].includes(parent.operatorToken.kind)
		)
			return true;
		if (
			(ts.isIfStatement(parent) ||
				ts.isWhileStatement(parent) ||
				ts.isDoStatement(parent) ||
				ts.isConditionalExpression(parent)) &&
			(ts.isConditionalExpression(parent) ? parent.condition : parent.expression) === node
		)
			return true;
		if (ts.isForStatement(parent) && parent.condition === node) return true;
		if (
			ts.isParenthesizedExpression(parent) ||
			ts.isPropertyAccessExpression(parent) ||
			ts.isElementAccessExpression(parent) ||
			ts.isNonNullExpression(parent)
		)
			continue;
		return false;
	}
	return false;
}
const canonicalSymbols = new WeakMap<Checker, WeakMap<ts.Node, Promise<CompilerSymbol | undefined>>>();
function canonical(checker: Checker, node: ts.Node): Promise<CompilerSymbol | undefined> {
	const symbols = canonicalSymbols.get(checker) ?? new WeakMap<ts.Node, Promise<CompilerSymbol | undefined>>();
	canonicalSymbols.set(checker, symbols);
	let result = symbols.get(node);
	if (!result) {
		result = (async () => {
			const symbol =
				ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
					? await checker.getShorthandAssignmentValueSymbol(node.parent)
					: await checker.getSymbolAtLocation(node);
			return symbol && symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
		})();
		symbols.set(node, result);
	}
	return result;
}
async function returnColour(checker: Checker, node: ts.CallExpression): Promise<Colour> {
	const signature = await checker.getResolvedSignature(node);
	const type = signature && (await checker.getReturnTypeOfSignature(signature));
	if (!type) return blank();
	const text = await checker.typeToString(type);
	return {
		async: !!(await checker.getPropertyOfType(type, "then")),
		generator: /^AsyncGenerator\s*</u.test(text),
		writes: false,
	};
}
function format(text: string, file: string): string {
	const biome = resolve(import.meta.dir, "../node_modules/.bin/biome");
	const result = Bun.spawnSync(
		[
			biome,
			"format",
			"--stdin-file-path",
			file.endsWith(".tsx") ? "src/async-port-output.tsx" : "src/async-port-output.ts",
			"--indent-style=tab",
			"--line-width=120",
		],
		{
			cwd: resolve(import.meta.dir, ".."),
			stdin: Buffer.from(text),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (result.exitCode !== 0) throw new Error(`Biome could not format ${file}: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

/** Uses compiler identities, never spelling alone, to connect declarations and call sites. */
async function planRound(options: PortOptions, virtual: ReadonlyMap<string, string>): Promise<PortPlan> {
	const root = resolve(options.root);
	// The removed legacy import is resolved only in the compiler's virtual view. It is never written back.
	// Callers still need its identity during the single conversion wave after U0 deletes the export.
	const kernelPath = resolve(root, "src/server/kernel/db.ts");
	const api = new API({
		cwd: root,
		fs: {
			readFile(file) {
				if (file !== kernelPath) return virtual.get(file);
				let text: string;
				try {
					text = virtual.get(file) ?? readFileSync(file, "utf8");
				} catch {
					return undefined;
				}
				return /export\s+(?:type|class|interface)\s+Db\b/u.test(text) || !/export\s+interface\s+WriteDb\b/u.test(text)
					? text
					: `${text}\nexport type Db = WriteDb;\n`;
			},
		},
	});
	const plan: PortPlan = {
		changes: [],
		diagnostics: [],
		pendingCalls: [],
		counts: { functionsColoured: 0, callsAwaited: 0, generatorsConverted: 0, refusals: {} },
	};
	try {
		const snapshot = await api.updateSnapshot({ openProjects: [resolve(root, options.project ?? "tsconfig.json")] });
		try {
			const project = snapshot.getProjects()[0];
			if (!project) throw new Error("No TypeScript project loaded");
			const checker = project.checker;
			const isApp = async (expression: ts.Node): Promise<boolean> => {
				const original = await checker.getTypeAtLocation(expression);
				const type = original && (await checker.getNonNullableType(original));
				const symbol = type && ((await type.getAliasSymbol()) ?? (await type.getSymbol()));
				if (!symbol) return false;
				for (const handle of symbol.declarations) {
					const declaration = await handle.resolve();
					if (
						declaration &&
						relative(root, declaration.getSourceFile().fileName) === "src/server/kernel/app.ts" &&
						name(declaration) === "App"
					)
						return true;
				}
				return false;
			};
			const files: ts.SourceFile[] = [];
			const selected = options.files?.map((file) => resolve(root, file));
			for (const file of [...(await project.program.getSourceFileNames())].sort()) {
				if (
					!file.startsWith(`${root}/`) ||
					file.includes("/node_modules/") ||
					file.endsWith(".d.ts") ||
					file.includes("/scripts/async-port/") ||
					file === resolve(root, "scripts/async-port.ts") ||
					file === resolve(root, "test/async-port.test.ts")
				)
					continue;
				const source = await project.program.getSourceFile(file);
				if (source) files.push(source);
			}
			const editable = (node: ts.Node): boolean => !selected || selected.includes(node.getSourceFile().fileName);
			const funcs = new Map<string, FunctionInfo>();
			const calls: CallInfo[] = [];
			const imports: ts.ImportDeclaration[] = [];
			const nodes: ts.Node[] = [];
			const identifiers = new Map<string, ts.Identifier[]>();
			const edits = new Map<ts.SourceFile, Splice[]>();
			const diagnosticKeys = new Set<string>();
			const refuse = (node: ts.Node, kind: RefusalKind, message: string): void => {
				if (!editable(node)) return;
				const source = node.getSourceFile();
				const diagnosticKey = `${key(node)}:${kind}`;
				if (diagnosticKeys.has(diagnosticKey)) return;
				diagnosticKeys.add(diagnosticKey);
				const prefix = source.text.slice(0, node.getStart());
				plan.diagnostics.push({
					file: relative(root, source.fileName),
					line: prefix.split("\n").length,
					column: prefix.length - prefix.lastIndexOf("\n"),
					kind,
					message,
				});
			};
			const splice = (node: ts.Node, start: number, end: number, text: string): void => {
				if (!editable(node)) return;
				const source = node.getSourceFile();
				const entries = edits.get(source) ?? [];
				entries.push({ start, end, text });
				edits.set(source, entries);
			};
			const replace = (node: ts.Node, text: string): void => splice(node, node.getStart(), node.end, text);
			for (const file of files)
				walk(file, (node) => {
					nodes.push(node);
					if (ts.isIdentifier(node)) {
						const entries = identifiers.get(node.text) ?? [];
						entries.push(node);
						identifiers.set(node.text, entries);
					}
					if (functionLike(node)) funcs.set(key(node), { node, colour: blank(), links: new Set(), blocked: false });
					if (ts.isImportDeclaration(node)) imports.push(node);
				});
			const info = (node: ts.Node | undefined): FunctionInfo | undefined => {
				if (node && ts.isVariableDeclaration(node) && node.initializer) node = unparen(node.initializer);
				if (node && ts.isPropertySignatureDeclaration(node) && node.type) node = node.type;
				return node ? funcs.get(key(node)) : undefined;
			};
			const seedFiles = new Map(
				(options.seeds ?? []).map((seed) => [`${resolve(root, seed.file)}:${seed.name}`, seed]),
			);
			const matchedSeeds = new Set<Seed>();
			for (const fn of funcs.values()) {
				const node = fn.node;
				const file = relative(root, node.getSourceFile().fileName);
				const memberName = name(node) || (ts.isVariableDeclaration(node.parent) ? name(node.parent) : "");
				const parentName = name(node.parent);
				const explicit =
					seedFiles.get(`${node.getSourceFile().fileName}:${memberName}`) ??
					seedFiles.get(`${node.getSourceFile().fileName}:${parentName}.${memberName}`);
				const kernel =
					file === "src/server/kernel/db.ts" &&
					["ReadDb", "WriteDb", "Database", "Db"].includes(parentName) &&
					kernelMethods.has(memberName);
				const open = file === "src/server/kernel/app.ts" && memberName === "openApp";
				if (explicit) matchedSeeds.add(explicit);
				if (explicit || kernel || open) {
					const gen = generator(node) || (!!node.type && /\b(?:Async)?Generator\s*</u.test(node.type.getText()));
					fn.colour = {
						async: !gen && !(kernel && memberName === "afterCommit"),
						generator: gen,
						writes: explicit?.write ?? (kernel && writeMethods.has(memberName)),
					};
				}
			}
			for (const seed of seedFiles.values())
				if (!matchedSeeds.has(seed)) throw new Error(`Seed not found: ${seed.file}:${seed.name}`);
			const symbols = new Map<number, FunctionInfo>();
			for (const fn of funcs.values()) {
				const named = "name" in fn.node ? fn.node.name : undefined;
				const symbol = named && (await canonical(checker, named));
				if (!symbol) continue;
				const previous = symbols.get(symbol.id);
				if (previous) {
					fn.links.add(previous);
					previous.links.add(fn);
				} else symbols.set(symbol.id, fn);
			}
			// Connect implementing class/object members to their interface/type declarations in both directions.
			const connect = async (fn: FunctionInfo, type: Type | undefined, memberName = name(fn.node)): Promise<void> => {
				if (!type) return;
				const member = await checker.getPropertyOfType(type, memberName);
				for (const handle of member?.declarations ?? []) {
					let declaration = await handle.resolve();
					if (
						declaration &&
						ts.isPropertySignatureDeclaration(declaration) &&
						declaration.type &&
						ts.isFunctionTypeNode(declaration.type)
					) {
						declaration = declaration.type;
					}
					const other = info(declaration);
					if (other && other !== fn) {
						fn.links.add(other);
						other.links.add(fn);
					}
				}
			};
			for (const fn of funcs.values()) {
				const parent = fn.node.parent;
				if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isInterfaceDeclaration(parent)) {
					for (const heritage of parent.heritageClauses ?? [])
						for (const type of heritage.types) {
							await connect(fn, await checker.getTypeAtLocation(type));
						}
				} else if (ts.isVariableDeclaration(parent) && parent.type && ts.isFunctionTypeNode(parent.type)) {
					const other = info(parent.type);
					if (other) {
						fn.links.add(other);
						other.links.add(fn);
					}
				} else if (ts.isVariableDeclaration(parent) && parent.type) {
					const type = await checker.getTypeAtLocation(parent.type);
					if (type)
						for (const signature of await checker.getSignaturesOfType(type, SignatureKind.Call)) {
							const other = info(await signature.declaration?.resolve());
							if (other) {
								fn.links.add(other);
								other.links.add(fn);
							}
						}
				} else if (ts.isObjectLiteralExpression(parent)) {
					await connect(fn, await checker.getContextualType(parent));
				} else if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
					await connect(fn, await checker.getContextualType(parent.parent), name(parent));
				}
			}
			for (const node of nodes) {
				if (!ts.isCallExpression(node)) continue;
				const signature = await checker.getResolvedSignature(node);
				const declaration = await signature?.declaration?.resolve();
				const target = info(declaration);
				const symbol = await canonical(
					checker,
					ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression,
				);
				const targets = target ? [target] : [];
				for (const handle of symbol?.declarations ?? []) {
					const other = info(await handle.resolve());
					if (other && !targets.includes(other)) targets.push(other);
				}
				if (!signature?.declaration && ts.isPropertyAccessExpression(node.expression)) {
					const type = await checker.getTypeAtLocation(node.expression.expression);
					const receiver = type && (await type.getSymbol());
					if (
						receiver &&
						["Db", "ReadDb", "WriteDb", "Database"].includes(receiver.name) &&
						receiver.declarations.some((handle) => handle.path.endsWith("/src/server/kernel/db.ts"))
					) {
						refuse(
							node,
							"unresolved-call",
							`Kernel method ${node.expression.name.text} has no resolved signature; port this removed API explicitly`,
						);
					}
				}
				const colour = blank();
				// Existing unrelated promises are not migration seeds. The signature distinguishes
				// async-generator seeds from functions returning ordinary promises.
				if (targets.some((entry) => entry.colour.async || entry.colour.generator)) {
					const declared = await returnColour(checker, node);
					colour.async = declared.async;
					colour.generator = declared.generator;
				}
				if (
					ts.isPropertyAccessExpression(node.expression) &&
					ts.isPropertyAccessExpression(node.expression.expression)
				) {
					const handle = node.expression.expression;
					if (
						["reader", "db"].includes(handle.name.text) &&
						kernelMethods.has(node.expression.name.text) &&
						(await isApp(handle.expression))
					) {
						colour.generator = ["savepointSteps", "checkedBulkSteps"].includes(node.expression.name.text);
						colour.async = !colour.generator && node.expression.name.text !== "afterCommit";
						colour.writes = writeMethods.has(node.expression.name.text);
						if (handle.name.text === "db")
							refuse(handle, "unresolved-call", "Replace App.db with an explicit database.write/read lease");
					}
				}
				calls.push({ node, owner: info(enclosing(node)), targets, colour });
			}
			const merge = (into: Colour, from: Colour): boolean => {
				const before = `${into.async}:${into.generator}:${into.writes}`;
				into.async ||= from.async;
				into.generator ||= from.generator;
				into.writes ||= from.writes;
				return before !== `${into.async}:${into.generator}:${into.writes}`;
			};
			const callsByNode = new Map(calls.map((call) => [call.node, call]));
			const promiseTypes = new Map<number, boolean>();
			const acceptsPromise = async (type: Type | undefined, containers = false, explicit = false): Promise<boolean> => {
				if (!type || type.isErrorType()) return false;
				if (type.flags & (TypeFlags.Any | TypeFlags.Unknown)) return !explicit;
				if (type.isTypeParameter()) {
					const constraint = await checker.getBaseConstraintOfType(type);
					return constraint ? acceptsPromise(constraint, containers, explicit) : !explicit;
				}
				if (type.isUnionType()) {
					for (const part of await type.getTypes()) if (await acceptsPromise(part, containers, explicit)) return true;
					return false;
				}
				if (await checker.getPropertyOfType(type, "then")) return true;
				if (containers && type.isTypeReference())
					for (const part of await checker.getTypeArguments(type))
						if (await acceptsPromise(part, true, explicit)) return true;
				return false;
			};
			const hasPromise = async (type: Type | undefined): Promise<boolean> => {
				if (!type || type.isErrorType()) return false;
				if (type.isUnionType()) {
					for (const part of await type.getTypes()) if (await hasPromise(part)) return true;
					return false;
				}
				return !!(await checker.getPropertyOfType(type, "then"));
			};
			const promiseFunctions = new Map<FunctionNode, boolean>();
			const returnsPromise = async (node: FunctionNode): Promise<boolean> => {
				const cached = promiseFunctions.get(node);
				if (cached !== undefined) return cached;
				const signature = await checker.getSignatureFromDeclaration(node);
				const type = signature && (await checker.getReturnTypeOfSignature(signature));
				const result = await hasPromise(type);
				promiseFunctions.set(node, result);
				return result;
			};
			const flexibleContracts = new Map<FunctionNode, Promise<boolean>>();
			const flexibleContract = (node: FunctionNode): Promise<boolean> => {
				if ("body" in node && node.body) return Promise.resolve(false);
				let result = flexibleContracts.get(node);
				if (!result) {
					result = (async () => {
						const signature = await checker.getSignatureFromDeclaration(node);
						const type = signature && (await checker.getReturnTypeOfSignature(signature));
						if (!type?.isUnionType()) return false;
						const parts = await type.getTypes();
						let promise = false,
							value = false;
						for (const part of parts) {
							if (await hasPromise(part)) promise = true;
							else value = true;
						}
						return promise && value;
					})();
					flexibleContracts.set(node, result);
				}
				return result;
			};
			const parameterAcceptsPromise = async (call: ts.CallExpression, index: number, containers: boolean) => {
				const signature = await checker.getResolvedSignature(call);
				if (!signature) return false;
				const declaration = await signature.declaration?.resolve();
				const result = outerExpression(call).parent;
				if (ts.isPropertyAccessExpression(result) && ["rejects", "resolves"].includes(result.name.text)) return true;
				if (declaration && name(declaration.parent) === "PromiseConstructor") return true;
				const parameter = declaration && functionLike(declaration) ? declaration.parameters[index] : undefined;
				const expected = await checker.getParameterType(signature, index);
				const declared = parameter?.type && (await checker.getTypeAtLocation(parameter.type));
				if ((await acceptsPromise(expected, containers, true)) || (await acceptsPromise(declared, containers, true)))
					return true;
				// Do not turn a synchronous value into a promise merely because a data sink uses unknown or T.
				// Once a value already is a promise, generic consumers can preserve it (including expect).
				const argument = call.arguments[index];
				const actual = argument && (await checker.getTypeAtLocation(argument));
				return (
					(await acceptsPromise(actual, containers, true)) &&
					((await acceptsPromise(expected, containers)) || (await acceptsPromise(declared, containers)))
				);
			};
			const references = new Map<number, ts.Identifier[]>();
			const usesOf = async (binding: ts.Identifier): Promise<ts.Identifier[]> => {
				const symbol = await canonical(checker, binding);
				if (!symbol) return [];
				const cached = references.get(symbol.id);
				if (cached) return cached;
				const uses: ts.Identifier[] = [];
				for (const candidate of identifiers.get(binding.text) ?? []) {
					if (candidate === binding) continue;
					if ((await canonical(checker, candidate))?.id === symbol.id) uses.push(candidate);
				}
				references.set(symbol.id, uses);
				return uses;
			};
			const forwardedValues = new Map<string, boolean>();
			const forwarded = async (
				value: ts.Node,
				owner: FunctionNode,
				visiting = new Set<ts.Node>(),
			): Promise<boolean> => {
				const node = outerExpression(value);
				if (visiting.has(node)) return false;
				const cacheKey = `${key(owner)}:${key(node)}`;
				const cached = forwardedValues.get(cacheKey);
				if (cached !== undefined) return cached;
				const next = new Set(visiting).add(node);
				const parent = node.parent;
				let result = false;
				if (
					ts.isReturnStatement(parent) ||
					ts.isYieldExpression(parent) ||
					(ts.isArrowFunction(parent) && parent.body === node)
				)
					result = true;
				else if (
					(ts.isConditionalExpression(parent) && parent.condition !== node) ||
					ts.isAsExpression(parent) ||
					ts.isSatisfiesExpression(parent) ||
					ts.isNonNullExpression(parent) ||
					(ts.isBinaryExpression(parent) &&
						parent.right === node &&
						[
							ts.SyntaxKind.QuestionQuestionToken,
							ts.SyntaxKind.BarBarToken,
							ts.SyntaxKind.AmpersandAmpersandToken,
						].includes(parent.operatorToken.kind))
				)
					result = await forwarded(parent, owner, next);
				else {
					const binding =
						ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)
							? parent.name
							: ts.isBinaryExpression(parent) &&
									parent.right === node &&
									ts.isIdentifier(parent.left) &&
									[
										ts.SyntaxKind.EqualsToken,
										ts.SyntaxKind.QuestionQuestionEqualsToken,
										ts.SyntaxKind.BarBarEqualsToken,
										ts.SyntaxKind.AmpersandAmpersandEqualsToken,
									].includes(parent.operatorToken.kind)
								? parent.left
								: undefined;
					if (binding)
						for (const use of await usesOf(binding)) {
							if (enclosing(use) === owner && (await forwarded(use, owner, next))) {
								result = true;
								break;
							}
						}
				}
				forwardedValues.set(cacheKey, result);
				return result;
			};
			const promiseValue = async (node: ts.Node): Promise<boolean> => {
				const expression = unparen(node);
				const type = await checker.getTypeAtLocation(expression);
				if (!type) return false;
				let value = promiseTypes.get(type.id);
				if (value === undefined) {
					value = await hasPromise(type);
					promiseTypes.set(type.id, value);
				}
				return value;
			};
			const classify = async (value: ts.Node, visiting: Set<ts.Node>, containers: boolean): Promise<boolean> => {
				const node = outerExpression(value);
				if (visiting.has(node)) return false;
				const next = new Set(visiting).add(node);
				const parent = node.parent;
				if (!parent) return false;
				if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent) || ts.isYieldExpression(parent))
					return !containers;
				if (ts.isArrowFunction(parent) && parent.body === node) return !containers;
				const valueType = booleanPosition(node) ? await checker.getTypeAtLocation(node) : undefined;
				if (valueType?.isUnionType()) {
					const parts = await valueType.getTypes();
					if (
						parts.some((part) => !!(part.flags & (TypeFlags.Undefined | TypeFlags.Null))) &&
						(await hasPromise(valueType))
					)
						return true;
				}
				if (ts.isConditionalExpression(parent) && parent.condition !== node) return handled(parent, next, containers);
				if (ts.isNonNullExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent))
					return handled(parent, next, containers);
				if (
					ts.isPropertyAccessExpression(parent) &&
					parent.expression === node &&
					["then", "catch", "finally"].includes(parent.name.text) &&
					ts.isCallExpression(parent.parent) &&
					parent.parent.expression === parent
				)
					return true;
				if (ts.isCallExpression(parent)) {
					const index = ts.isExpression(node) ? parent.arguments.indexOf(node) : -1;
					return index >= 0 && parameterAcceptsPromise(parent, index, containers);
				}
				if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
					const actual = await checker.getTypeAtLocation(node);
					const promise = await hasPromise(actual);
					if (ts.isObjectLiteralExpression(parent.parent)) {
						const context = await checker.getContextualType(parent.parent);
						const property = context && (await checker.getPropertyOfType(context, name(parent)));
						if (property) {
							const expected = await checker.getTypeOfSymbolAtLocation(property, parent);
							return (await acceptsPromise(expected, false, true)) || (promise && (await acceptsPromise(expected)));
						}
					}
					if (ts.isIdentifier(node) && promise) return handled(parent.parent, next, containers);
				}
				if (ts.isArrayLiteralExpression(parent)) return handled(parent, next, true);
				if (
					ts.isBinaryExpression(parent) &&
					[
						ts.SyntaxKind.EqualsEqualsEqualsToken,
						ts.SyntaxKind.ExclamationEqualsEqualsToken,
						ts.SyntaxKind.EqualsEqualsToken,
						ts.SyntaxKind.ExclamationEqualsToken,
					].includes(parent.operatorToken.kind)
				)
					return promiseValue(parent.left === node ? parent.right : parent.left);
				if (
					ts.isBinaryExpression(parent) &&
					parent.right === node &&
					[
						ts.SyntaxKind.QuestionQuestionToken,
						ts.SyntaxKind.BarBarToken,
						ts.SyntaxKind.AmpersandAmpersandToken,
					].includes(parent.operatorToken.kind)
				)
					return handled(parent, next, containers);
				let binding: ts.Identifier | undefined;
				if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name))
					binding = parent.name;
				else if (
					ts.isBinaryExpression(parent) &&
					[
						ts.SyntaxKind.EqualsToken,
						ts.SyntaxKind.QuestionQuestionEqualsToken,
						ts.SyntaxKind.BarBarEqualsToken,
						ts.SyntaxKind.AmpersandAmpersandEqualsToken,
					].includes(parent.operatorToken.kind) &&
					parent.right === node &&
					ts.isIdentifier(parent.left)
				)
					binding = parent.left;
				if (binding) {
					let consumed = false;
					for (const use of await usesOf(binding)) {
						if (ts.isVariableDeclaration(use.parent) && use.parent.name === use) continue;
						if (
							ts.isBinaryExpression(use.parent) &&
							[
								ts.SyntaxKind.EqualsToken,
								ts.SyntaxKind.QuestionQuestionEqualsToken,
								ts.SyntaxKind.BarBarEqualsToken,
								ts.SyntaxKind.AmpersandAmpersandEqualsToken,
							].includes(use.parent.operatorToken.kind) &&
							use.parent.left === use
						)
							continue;
						if (!(await handled(use, next, containers))) return false;
						consumed = true;
					}
					return consumed;
				}
				return false;
			};
			const handledCache = new Map<ts.Node, Map<boolean, Promise<boolean>>>();
			const handled = (value: ts.Node, visiting = new Set<ts.Node>(), containers = false): Promise<boolean> => {
				const node = outerExpression(value);
				if (visiting.has(node)) return Promise.resolve(false);
				const cached = handledCache.get(node) ?? new Map<boolean, Promise<boolean>>();
				handledCache.set(node, cached);
				let result = cached.get(containers);
				if (!result) {
					result = classify(node, visiting, containers);
					cached.set(containers, result);
				}
				return result;
			};
			const generatorBindings = new Map<number, CallInfo>();
			for (const call of calls) {
				const declaration = call.node.parent;
				if (!ts.isVariableDeclaration(declaration)) continue;
				const symbol = await canonical(checker, declaration.name);
				if (symbol) generatorBindings.set(symbol.id, call);
			}
			const iterations: {
				node: ts.ForOfStatement;
				call: CallInfo | undefined;
				receiver: number | undefined;
				owner: FunctionInfo | undefined;
			}[] = [];
			for (const node of nodes)
				if (ts.isForOfStatement(node)) {
					const expression = unparen(node.expression);
					const symbol = ts.isIdentifier(expression) ? await canonical(checker, expression) : undefined;
					const call = symbol
						? generatorBindings.get(symbol.id)
						: ts.isCallExpression(expression)
							? callsByNode.get(expression)
							: undefined;
					iterations.push({ node, call, receiver: symbol?.id, owner: info(enclosing(node)) });
				}
			const generatorSymbols = new Set<number>();
			const generatorParams = new Map<number, ts.ParameterDeclaration>();
			const generatorArguments = new Set<ts.Node>();
			const iteratorCalls: { call: CallInfo; receiver: number | undefined; source: CallInfo | undefined }[] = [];
			const parameterFlows: {
				source: CallInfo | undefined;
				receiver: number | undefined;
				parameter: ts.ParameterDeclaration;
				symbol: number;
				argument: ts.Node;
			}[] = [];
			for (const call of calls) {
				if (
					ts.isPropertyAccessExpression(call.node.expression) &&
					["next", "return", "throw"].includes(call.node.expression.name.text)
				) {
					const receiver = unparen(call.node.expression.expression);
					const symbol = ts.isIdentifier(receiver) ? await canonical(checker, receiver) : undefined;
					iteratorCalls.push({
						call,
						receiver: symbol?.id,
						source: ts.isCallExpression(receiver) ? callsByNode.get(receiver) : undefined,
					});
				}
				if (!call.targets.length) continue;
				for (const [index, argument] of call.node.arguments.entries()) {
					const arg = unparen(argument);
					const receiver = ts.isIdentifier(arg) ? await canonical(checker, arg) : undefined;
					const source = ts.isCallExpression(arg) ? callsByNode.get(arg) : undefined;
					if (!source && !receiver) continue;
					for (const target of call.targets) {
						const parameter = target.node.parameters[index];
						const symbol = parameter && (await canonical(checker, parameter.name));
						if (parameter && symbol)
							parameterFlows.push({ source, receiver: receiver?.id, parameter, symbol: symbol.id, argument: arg });
					}
				}
			}
			const isGeneratorValue = (source: CallInfo | undefined, symbol: number | undefined): boolean =>
				!!source?.colour.generator ||
				(symbol !== undefined && (generatorSymbols.has(symbol) || !!generatorBindings.get(symbol)?.colour.generator));
			let changed = true;
			while (changed) {
				handledCache.clear();
				changed = false;
				for (const flow of parameterFlows)
					if (isGeneratorValue(flow.source, flow.receiver)) {
						generatorArguments.add(flow.argument);
						if (!generatorSymbols.has(flow.symbol)) {
							generatorSymbols.add(flow.symbol);
							generatorParams.set(flow.symbol, flow.parameter);
							changed = true;
						}
					}
				for (const iterator of iteratorCalls)
					if (isGeneratorValue(iterator.source, iterator.receiver) && !iterator.call.colour.async) {
						iterator.call.colour.async = true;
						changed = true;
					}
				for (const fn of funcs.values())
					for (const linked of fn.links) {
						// A contract that already permits either kind of return does not require synchronous siblings to change.
						const colour = (await flexibleContract(linked.node)) ? { ...linked.colour, async: false } : linked.colour;
						changed = merge(fn.colour, colour) || changed;
					}
				for (const iteration of iterations)
					if (isGeneratorValue(iteration.call, iteration.receiver) && iteration.owner) {
						const gen = generator(iteration.owner.node);
						changed =
							merge(iteration.owner.colour, {
								async: !gen,
								generator: gen,
								writes: iteration.call?.colour.writes ?? false,
							}) || changed;
					}
				for (const call of calls) {
					for (const target of call.targets) changed = merge(call.colour, target.colour) || changed;
					if (!call.owner) continue;
					const expression = outerExpression(call.node);
					const delegates =
						call.colour.generator && ts.isYieldExpression(expression.parent) && !!expression.parent.asteriskToken;
					const returnsGenerator =
						call.colour.generator &&
						(ts.isReturnStatement(expression.parent) ||
							(ts.isArrowFunction(expression.parent) && expression.parent.body === expression));
					if (returnsGenerator)
						changed =
							merge(call.owner.colour, { async: false, generator: true, writes: call.colour.writes }) || changed;
					const iteration =
						call.colour.generator && ts.isForOfStatement(call.node.parent) && call.node.parent.expression === call.node;
					const expressionParent = expression.parent;
					const forwards =
						ts.isReturnStatement(expressionParent) ||
						ts.isYieldExpression(expressionParent) ||
						(ts.isArrowFunction(expressionParent) && expressionParent.body === expression);
					if (
						(call.colour.async &&
							(forwards ||
								asyncModifier(call.owner.node) ||
								(await returnsPromise(call.owner.node)) ||
								(await forwarded(call.node, call.owner.node)) ||
								!(await handled(call.node)))) ||
						delegates ||
						iteration
					) {
						const gen = generator(call.owner.node);
						changed = merge(call.owner.colour, { async: !gen, generator: gen, writes: call.colour.writes }) || changed;
					} else if (call.colour.writes && !call.owner.colour.writes) {
						call.owner.colour.writes = true;
						changed = true;
					}
				}
			}
			const handledCalls = new Set<ts.CallExpression>();
			for (const call of calls) if (call.colour.async && (await handled(call.node))) handledCalls.add(call.node);
			for (const parameter of generatorParams.values()) {
				if (!parameter.type) continue;
				const type = parameter.type;
				if (ts.isTypeReferenceNode(type) && type.typeName.getText() === "Generator")
					replace(type.typeName, "AsyncGenerator");
				else if (!/^AsyncGenerator\s*</u.test(type.getText()))
					refuse(type, "generator-use", "Convert this generator parameter alias to AsyncGenerator explicitly");
			}
			const callbackAcceptsPromise = async (node: FunctionNode): Promise<boolean> => {
				const parent = outerExpression(node).parent;
				if (!ts.isCallExpression(parent)) return false;
				const signature = await checker.getResolvedSignature(parent);
				const declaration = await signature?.declaration?.resolve();
				if (!declaration || !functionLike(declaration)) return false;
				const argument = outerExpression(node);
				const index = ts.isExpression(argument) ? parent.arguments.indexOf(argument) : -1;
				const parameter = declaration.parameters[index];
				const type = parameter?.type && (await checker.getTypeAtLocation(parameter.type));
				if (!type) return false;
				for (const expected of await checker.getSignaturesOfType(type, SignatureKind.Call))
					if (await acceptsPromise(await checker.getReturnTypeOfSignature(expected))) return true;
				return false;
			};
			// A callback's contextual return type determines whether changing it would break its caller.
			for (const fn of funcs.values()) {
				if (!fn.colour.async && !fn.colour.generator) continue;
				const node = fn.node;
				if (fn.colour.generator && !generator(node) && (fn.colour.async || asyncModifier(node))) {
					fn.blocked = true;
					refuse(
						node,
						"external-contract",
						"A promise-returning wrapper around a generator needs explicit iterator ownership",
					);
				}
				if (node.type && ts.isTypePredicateNode(node.type)) {
					fn.blocked = true;
					refuse(node, "external-contract", "A type predicate cannot become an async predicate");
				}
				if (
					arrayCallback(node) &&
					!(
						ts.isCallExpression(node.parent) &&
						ts.isPropertyAccessExpression(node.parent.expression) &&
						node.parent.expression.name.text === "map" &&
						(await handled(node.parent, new Set(), true))
					)
				) {
					fn.blocked = true;
					refuse(node, "array-callback", "Convert array iteration deliberately; promise callbacks change its contract");
				}
				if (
					ts.isConstructorDeclaration(node) ||
					ts.isGetAccessorDeclaration(node) ||
					ts.isSetAccessorDeclaration(node)
				) {
					fn.blocked = true;
					refuse(node, "constructor-accessor-field", "An accessor or constructor cannot become async");
				}
				if (
					(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
					!asyncModifier(node) &&
					!fn.links.size &&
					!(await callbackAcceptsPromise(node))
				) {
					const type = await checker.getContextualType(node);
					if (type)
						for (const signature of await checker.getSignaturesOfType(type, SignatureKind.Call)) {
							const ret = await checker.getReturnTypeOfSignature(signature);
							const text = ret && (await checker.typeToString(ret));
							if (text && !(await acceptsPromise(ret)) && !/\bAsyncGenerator\b/u.test(text) && !text.includes("=>")) {
								fn.blocked = true;
								refuse(node, "sync-callback", `Callback expects synchronous ${text}`);
							}
						}
				}
			}
			// Named coloured functions can also be passed through a synchronous callback boundary.
			for (const call of calls) {
				const signature = await checker.getResolvedSignature(call.node);
				if (!signature) continue;
				for (const [index, arg] of call.node.arguments.entries()) {
					if (!ts.isIdentifier(arg) && !ts.isPropertyAccessExpression(arg)) continue;
					const symbol = await canonical(checker, arg);
					const targets: FunctionInfo[] = [];
					for (const handle of symbol?.declarations ?? []) {
						const target = info(await handle.resolve());
						if (target) targets.push(target);
					}
					if (!targets.some((target) => target.colour.async || target.colour.generator)) continue;
					const type = await checker.getParameterType(signature, index);
					if (!type) continue;
					for (const expected of await checker.getSignaturesOfType(type, SignatureKind.Call)) {
						const ret = await checker.getReturnTypeOfSignature(expected);
						const text = ret && (await checker.typeToString(ret));
						if (text && !(await acceptsPromise(ret)) && !/\bAsyncGenerator\b/u.test(text))
							refuse(arg, "sync-callback", `Coloured function passed to synchronous ${text} callback`);
					}
				}
			}
			for (const fn of funcs.values()) {
				const node = fn.node;
				if (!fn.colour.async && !fn.colour.generator) continue;
				const body = "body" in node && node.body;
				const kernel = relative(root, node.getSourceFile().fileName) === "src/server/kernel/db.ts";
				if (kernel) continue; // U0 owns these declarations, which are seeds, not conversion targets.
				if (editable(node)) plan.counts.functionsColoured++;
				if (fn.blocked) continue;
				const needsAwait = calls.some((call) => call.owner === fn && call.colour.async && !handledCalls.has(call.node));
				const alreadyPromise = await returnsPromise(node);
				if (body && !asyncModifier(node) && (needsAwait || generator(node) || (fn.colour.async && !alreadyPromise))) {
					let start = node.getStart();
					if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
						const offset = node.getText().search(/\bfunction\b/u);
						start += offset;
					} else if (ts.isMethodDeclaration(node)) {
						start = node.asteriskToken?.getStart() ?? node.name.getStart();
					}
					splice(node, start, start, "async ");
					if (fn.colour.generator && editable(node)) plan.counts.generatorsConverted++;
				}
				if (node.type) {
					const text = node.type.getText();
					if (fn.colour.generator && /^Generator\s*</u.test(text))
						replace(node.type, text.replace(/^Generator/u, "AsyncGenerator"));
					else if (fn.colour.async && !alreadyPromise) replace(node.type, `Promise<${text}>`);
				}
			}
			for (const { node, call, receiver, owner } of iterations)
				if (isGeneratorValue(call, receiver) && !node.awaitModifier) {
					if (owner?.blocked || unsafeBody(node))
						refuse(node, "generator-use", "Async iteration needs an async-capable enclosing function");
					else splice(node, node.getStart() + 3, node.getStart() + 3, " await");
				}
			for (const node of nodes) {
				if (ts.isPropertyAccessExpression(node) && node.name.text === "lastId") {
					const direct =
						ts.isCallExpression(node.expression) &&
						callsByNode.get(node.expression)?.colour.async &&
						ts.isPropertyAccessExpression(node.expression.expression) &&
						node.expression.expression.name.text === "run";
					if (!direct)
						refuse(node, "returning-id", "Stored run result uses lastId; read RETURNING id with one/get instead");
				} else if (ts.isBindingElement(node) && (node.propertyName?.getText() ?? name(node)) === "lastId") {
					refuse(node, "returning-id", "Destructured lastId needs RETURNING id and a one/get call");
				}
			}
			for (const call of calls) {
				const node = call.node;
				if (relative(root, node.getSourceFile().fileName) === "src/server/kernel/db.ts") continue;
				if (ts.isPropertyAccessExpression(node.expression) && ["get", "one"].includes(node.expression.name.text)) {
					const statement = node.arguments[0];
					const symbol = statement && (await canonical(checker, statement));
					let sql = "";
					for (const handle of symbol?.declarations ?? []) sql += (await handle.resolve())?.getText() ?? "";
					const expression = outerExpression(node);
					const result = ts.isAwaitExpression(expression.parent) ? outerExpression(expression.parent) : expression;
					const id = ts.isPropertyAccessExpression(result.parent) && result.parent.name.text === "id";
					if (id && /\bINSERT\b/iu.test(sql) && !/\bRETURNING\s+id\b/iu.test(sql))
						refuse(
							statement ?? node,
							"returning-id",
							`${statement?.getText()} needs RETURNING id and an { id: number } row type`,
						);
				}
				if (call.colour.generator) {
					const parent = outerExpression(node).parent;
					if (
						!(ts.isYieldExpression(parent) && parent.asteriskToken) &&
						!ts.isForOfStatement(parent) &&
						!ts.isVariableDeclaration(parent) &&
						!ts.isReturnStatement(parent) &&
						!(ts.isArrowFunction(parent) && parent.body === outerExpression(node)) &&
						!generatorArguments.has(unparen(node))
					) {
						// Generator arguments are accepted only by the kernel's savepointSteps; others need inspection.
						if (
							!ts.isCallExpression(parent) ||
							!ts.isPropertyAccessExpression(parent.expression) ||
							parent.expression.name.text !== "savepointSteps"
						)
							refuse(node, "generator-use", "Inspect consumption of this async generator");
					}
					continue;
				}
				if (!call.colour.async || handledCalls.has(node)) continue;
				if (editable(node)) {
					const prefix = node.getSourceFile().text.slice(0, node.getStart());
					plan.pendingCalls.push({
						file: relative(root, node.getSourceFile().fileName),
						line: prefix.split("\n").length,
						column: prefix.length - prefix.lastIndexOf("\n"),
					});
				}
				if (call.owner?.blocked || unsafeBody(node)) {
					if (unsafeBody(node))
						refuse(node, "constructor-accessor-field", "Promise used in constructor, accessor or field initializer");
					continue;
				}
				let parameter = node.parent;
				while (
					parameter &&
					!functionLike(parameter) &&
					!ts.isSourceFile(parameter) &&
					!ts.isParameterDeclaration(parameter)
				)
					parameter = parameter.parent;
				if (parameter && ts.isParameterDeclaration(parameter)) {
					refuse(node, "external-contract", "Parameter initializers cannot await; move this work into the body");
					continue;
				}
				if (booleanPosition(node)) {
					refuse(node, "boolean-position", "Await explicitly and review this boolean/nullish/comparison branch");
					continue;
				}
				const parent = node.parent;
				if (
					ts.isPropertyAccessExpression(parent) &&
					parent.name.text === "lastId" &&
					ts.isPropertyAccessExpression(node.expression) &&
					node.expression.name.text === "run"
				) {
					const statement = node.arguments[0];
					const symbol = statement && (await canonical(checker, statement));
					let sql = "";
					for (const handle of symbol?.declarations ?? []) sql += (await handle.resolve())?.getText() ?? "";
					const nullable = /ON\s+CONFLICT[\s\S]*DO\s+NOTHING/iu.test(sql);
					const start = node.expression.name.getStart();
					splice(node, start, node.expression.name.end, nullable ? "get" : "one");
					splice(node, node.getStart(), node.getStart(), "(await ");
					splice(node, node.end, node.end, nullable ? ")?" : ")");
					replace(parent.name, "id");
					refuse(
						statement ?? node,
						"returning-id",
						`${statement?.getText() ?? "statement"} needs RETURNING id and an { id: number } row type${nullable ? "; review the zero-row case" : ""}`,
					);
				} else {
					splice(node, node.getStart(), node.getStart(), "(await ");
					splice(node, node.end, node.end, ")");
				}
				if (editable(node)) plan.counts.callsAwaited++;
			}
			// A whole call containing app.reader can be enclosed in one lexical read scope.
			const readerScopes = new Map<ts.CallExpression, ts.PropertyAccessExpression[]>();
			for (const node of nodes) {
				if (
					ts.isElementAccessExpression(node) &&
					ts.isStringLiteral(node.argumentExpression) &&
					node.argumentExpression.text === "reader" &&
					(await isApp(node.expression))
				) {
					refuse(node, "reader-scope", "Indexed reader access needs an explicit lexical read scope");
				} else if (ts.isBindingElement(node) && (node.propertyName?.getText() ?? name(node)) === "reader") {
					const declaration = node.parent.parent;
					const source = ts.isVariableDeclaration(declaration)
						? declaration.initializer
						: ts.isParameterDeclaration(declaration)
							? declaration
							: undefined;
					if (source && (await isApp(source)))
						refuse(node, "reader-scope", "A destructured reader would escape the read lease");
				}
			}

			for (const node of nodes)
				if (ts.isPropertyAccessExpression(node) && node.name.text === "reader") {
					if (!(await isApp(node.expression))) continue;
					let call: ts.CallExpression | undefined;
					if (ts.isCallExpression(node.parent) && node.parent.arguments.some((arg) => arg === node)) call = node.parent;
					else if (ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent))
						call = node.parent.parent;
					if (
						!call ||
						!ts.isIdentifier(node.expression) ||
						!calls.some((entry) => entry.node === call && entry.colour.async && !entry.colour.writes) ||
						info(enclosing(call))?.blocked ||
						unsafeBody(call) ||
						booleanPosition(call) ||
						(ts.isPropertyAccessExpression(call.expression) &&
							["snapshot", "snapshotAsync"].includes(call.expression.name.text))
					) {
						refuse(node, "reader-scope", "Choose the read scope and its authority recheck explicitly");
						continue;
					}
					const scopes = readerScopes.get(call) ?? [];
					scopes.push(node);
					readerScopes.set(call, scopes);
				}
			for (const [call, readers] of readerScopes) {
				if (readers.some((reader) => reader.expression.getText() !== readers[0]?.expression.getText())) {
					for (const reader of readers)
						refuse(reader, "reader-scope", "Call combines different applications' read handles");
					continue;
				}
				const first = readers[0];
				if (!first) continue;
				let local = "readDb";
				while (new RegExp(`\\b${local}\\b`, "u").test(call.getText())) local += "_";
				for (const reader of readers) replace(reader, local);
				splice(
					call,
					call.getStart(),
					call.getStart(),
					`${handledCalls.has(call) ? "(" : "(await "}${first.expression.getText()}.database.read(async (${local}) => `,
				);
				splice(call, call.end, call.end, "))");
			}
			const needed = new Map<ts.SourceFile, Set<string>>();
			const legacyDbFiles = new Set<ts.SourceFile>();
			for (const node of nodes)
				if (ts.isTypeReferenceNode(node)) {
					const symbol = await canonical(checker, node.typeName);
					const isDb =
						symbol?.name === "Db" &&
						symbol.declarations.some((handle) => handle.path.endsWith("/src/server/kernel/db.ts"));
					if (!isDb || relative(root, node.getSourceFile().fileName) === "src/server/kernel/db.ts") continue;
					if (!ts.isParameterDeclaration(node.parent) || node.parent.type !== node) {
						legacyDbFiles.add(node.getSourceFile());
						refuse(node, "legacy-db-type", "Db outside a direct parameter type needs an explicit scoped type");
						continue;
					}
					const fn = info(node.parent.parent);
					const type = fn?.colour.writes ? "WriteDb" : "ReadDb";
					replace(node, type);
					const names = needed.get(node.getSourceFile()) ?? new Set<string>();
					names.add(type);
					needed.set(node.getSourceFile(), names);
				}
			const suppliedTypes = new Set<ts.SourceFile>();
			for (const declaration of imports) {
				const names = needed.get(declaration.getSourceFile());
				const bindings = declaration.importClause?.namedBindings;
				if (!names || !bindings || !ts.isNamedImports(bindings)) continue;
				const db = bindings.elements.find((element) => (element.propertyName ?? element.name).text === "Db");
				if (!db) continue;
				suppliedTypes.add(declaration.getSourceFile());
				const missing = [...names]
					.sort()
					.filter((type) => !bindings.elements.some((element) => element.name.text === type));
				const typePrefix = declaration.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ? "" : "type ";
				const replacements = [
					...(legacyDbFiles.has(declaration.getSourceFile()) ? [db.getText()] : []),
					...missing.map((type) => `${typePrefix}${type}`),
				];
				if (replacements.length) replace(db, replacements.join(", "));
				else {
					const index = bindings.elements.indexOf(db);
					const next = bindings.elements[index + 1];
					const previous = bindings.elements[index - 1];
					splice(db, next ? db.getStart() : (previous?.end ?? db.getStart()), next?.getStart() ?? db.end, "");
				}
			}
			for (const [source, types] of needed)
				if (!suppliedTypes.has(source)) {
					const module = relative(resolve(source.fileName, ".."), kernelPath);
					splice(
						source,
						source.text.startsWith("#!") ? source.text.indexOf("\n") + 1 : 0,
						source.text.startsWith("#!") ? source.text.indexOf("\n") + 1 : 0,
						`import type { ${[...types].sort().join(", ")} } from ${JSON.stringify(module.startsWith(".") ? module : `./${module}`)};\n`,
					);
				}
			for (const [source, entries] of edits) {
				// Stable insertion order handles nested await/scope wrappers at the same offset.
				entries.sort((a, b) => b.start - a.start || b.end - a.end);
				let boundary = source.text.length;
				let after = source.text;
				for (const entry of entries) {
					if (entry.end > boundary) throw new Error(`Overlapping edits at ${source.fileName}:${entry.start}`);
					after = after.slice(0, entry.start) + entry.text + after.slice(entry.end);
					boundary = entry.start;
				}
				if (after !== source.text)
					plan.changes.push({
						file: relative(root, source.fileName),
						before: source.text,
						after: format(after, source.fileName),
					});
			}
			plan.changes.sort((a, b) => a.file.localeCompare(b.file));
			plan.diagnostics.sort(
				(a, b) =>
					a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.kind.localeCompare(b.kind),
			);

			for (const diagnostic of plan.diagnostics)
				plan.counts.refusals[diagnostic.kind] = (plan.counts.refusals[diagnostic.kind] ?? 0) + 1;
			return plan;
		} finally {
			await snapshot.dispose();
		}
	} finally {
		await api.close();
	}
}

/** Re-infer edited return types without writing any intermediate source to disk. */
export async function planAsyncPort(options: PortOptions): Promise<PortPlan> {
	const virtual = new Map<string, string>();
	const changes = new Map<string, PortPlan["changes"][number]>();
	const pending = new Map<string, PortPlan["pendingCalls"][number]>();
	const seen = new Set<string>();
	let callsAwaited = 0;
	let generatorsConverted = 0;
	let functionsColoured = 0;
	for (;;) {
		const plan = await planRound(options, virtual);
		functionsColoured = Math.max(functionsColoured, plan.counts.functionsColoured);
		callsAwaited += plan.counts.callsAwaited;
		generatorsConverted += plan.counts.generatorsConverted;
		for (const call of plan.pendingCalls) pending.set(`${call.file}:${call.line}:${call.column}`, call);
		if (!plan.changes.length)
			return {
				...plan,
				changes: [...changes.values()].sort((a, b) => a.file.localeCompare(b.file)),
				pendingCalls: [...pending.values()],
				counts: { ...plan.counts, functionsColoured, callsAwaited, generatorsConverted },
			};
		for (const change of plan.changes) {
			const previous = changes.get(change.file);
			changes.set(change.file, { ...change, before: previous?.before ?? change.before });
			virtual.set(resolve(options.root, change.file), change.after);
		}
		const state = JSON.stringify([...virtual]);
		if (seen.has(state)) throw new Error("Async conversion did not converge");
		seen.add(state);
	}
}

export async function asyncPort(args: string[]): Promise<number> {
	let root = process.cwd();
	let project = "tsconfig.json";
	let seeds: Seed[] = [];
	let check = false;
	let dryRun = false;
	const files: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--check") check = true;
		else if (arg === "--dry-run") dryRun = true;
		else if (arg === "--root" || arg === "--project" || arg === "--seeds") {
			const value = args[++index];
			if (!value) throw new Error(`${arg} needs a value`);
			if (arg === "--root") root = resolve(value);
			else if (arg === "--project") project = value;
			else seeds = seedSchema.parse(JSON.parse(readFileSync(resolve(root, value), "utf8")));
		} else if (arg?.startsWith("--")) throw new Error(`Unknown option ${arg}`);
		else if (arg) files.push(isAbsolute(arg) ? arg : resolve(root, arg));
	}
	const plan = await planAsyncPort({ root, project, seeds, ...(files.length ? { files } : {}) });
	for (const change of plan.changes) {
		console.log(`${check || dryRun ? "would change" : "change"} ${change.file}`);
		if (!check && !dryRun) {
			const path = resolve(root, change.file);
			if (readFileSync(path, "utf8") !== change.before) throw new Error(`File changed since analysis: ${path}`);
			writeFileSync(path, change.after);
		}
	}
	if (check)
		for (const call of plan.pendingCalls)
			console.log(`${call.file}:${call.line}:${call.column} [unawaited-call] Coloured call needs await`);
	for (const diagnostic of plan.diagnostics)
		console.log(
			`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} [${diagnostic.kind}] ${diagnostic.message}`,
		);
	console.log(JSON.stringify({ ...plan.counts, filesChanged: plan.changes.length }));
	return (check && (plan.changes.length > 0 || plan.diagnostics.length > 0)) ||
		(!check && !dryRun && plan.diagnostics.length > 0)
		? 1
		: 0;
}
if (import.meta.main) process.exitCode = await asyncPort(process.argv.slice(2));
