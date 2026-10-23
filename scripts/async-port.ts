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
function awaited(node: ts.Node): boolean {
	while (node.parent && ts.isParenthesizedExpression(node.parent)) node = node.parent;
	return !!node.parent && ts.isAwaitExpression(node.parent);
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
async function canonical(checker: Checker, node: ts.Node): Promise<CompilerSymbol | undefined> {
	const symbol = await checker.getSymbolAtLocation(node);
	return symbol && symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
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
export async function planAsyncPort(options: PortOptions): Promise<PortPlan> {
	const root = resolve(options.root);
	// The removed legacy import is resolved only in the compiler's virtual view. It is never written back.
	// Callers still need its identity during the single conversion wave after U0 deletes the export.
	const kernelPath = resolve(root, "src/server/kernel/db.ts");
	const api = new API({
		cwd: root,
		fs: {
			readFile(file) {
				if (file !== kernelPath) return undefined;
				let text: string;
				try {
					text = readFileSync(file, "utf8");
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
					for (const linked of fn.links) changed = merge(fn.colour, linked.colour) || changed;
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
					if (call.colour.async || delegates || iteration) {
						const gen = generator(call.owner.node);
						changed = merge(call.owner.colour, { async: !gen, generator: gen, writes: call.colour.writes }) || changed;
					} else if (call.colour.writes && !call.owner.colour.writes) {
						call.owner.colour.writes = true;
						changed = true;
					}
				}
			}
			for (const parameter of generatorParams.values()) {
				if (!parameter.type) continue;
				const type = parameter.type;
				if (ts.isTypeReferenceNode(type) && type.typeName.getText() === "Generator")
					replace(type.typeName, "AsyncGenerator");
				else if (!/^AsyncGenerator\s*</u.test(type.getText()))
					refuse(type, "generator-use", "Convert this generator parameter alias to AsyncGenerator explicitly");
			}
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
				if (arrayCallback(node)) {
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
				if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !fn.links.size) {
					const type = await checker.getContextualType(node);
					if (type)
						for (const signature of await checker.getSignaturesOfType(type, SignatureKind.Call)) {
							const ret = await checker.getReturnTypeOfSignature(signature);
							const text = ret && (await checker.typeToString(ret));
							if (text && !/\b(?:Promise(?:Like)?|AsyncGenerator)\b/u.test(text) && !text.includes("=>")) {
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
						if (text && !/\b(?:Promise(?:Like)?|AsyncGenerator)\b/u.test(text))
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
				if (body && !asyncModifier(node) && (fn.colour.async || generator(node))) {
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
					else if (fn.colour.async && !/^Promise(?:Like)?\s*</u.test(text)) replace(node.type, `Promise<${text}>`);
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
				} else if (
					(ts.isBindingElement(node) && name(node) === "lastId") ||
					(ts.isBindingElement(node) && node.propertyName?.getText() === "lastId")
				) {
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
				if (!call.colour.async || awaited(node)) continue;
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
				if (
					ts.isPropertyAccessExpression(node.parent) &&
					["then", "catch", "finally"].includes(node.parent.name.text)
				) {
					refuse(node, "external-contract", "Existing promise chain needs review rather than awaiting its receiver");
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
					`(await ${first.expression.getText()}.database.read(async (${local}) => `,
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
