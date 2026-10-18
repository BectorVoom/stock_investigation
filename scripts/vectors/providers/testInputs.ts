/** Collect constant provider-schema inputs from the existing TS test source without executing tests. */
import { readdir, readFile } from "node:fs/promises";
import ts from "typescript";

const unavailable = Symbol("not a constant expression");
function constant(node: ts.Node, names: ReadonlyMap<string, unknown>): unknown {
	if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
		return constant(node.expression, names);
	if (ts.isStringLiteralLike(node)) return node.text;
	if (ts.isNumericLiteral(node)) return Number(node.text);
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (node.kind === ts.SyntaxKind.NullKeyword) return null;
	if (ts.isIdentifier(node)) return names.has(node.text) ? names.get(node.text) : unavailable;
	if (ts.isPrefixUnaryExpression(node)) {
		const value = constant(node.operand, names);
		if (typeof value === "number")
			return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
	}
	if (ts.isArrayLiteralExpression(node)) {
		const values = node.elements.map((v) => constant(v, names));
		return values.includes(unavailable) ? unavailable : values;
	}
	if (ts.isObjectLiteralExpression(node)) {
		const result: Record<string, unknown> = {};
		for (const property of node.properties) {
			if (ts.isSpreadAssignment(property)) {
				const value = constant(property.expression, names);
				if (typeof value !== "object" || value === null || Array.isArray(value)) return unavailable;
				Object.assign(result, value);
			} else if (ts.isPropertyAssignment(property)) {
				const key = property.name;
				if (!ts.isIdentifier(key) && !ts.isStringLiteralLike(key)) return unavailable;
				const value = constant(property.initializer, names);
				if (value === unavailable) return unavailable;
				result[key.text] = value;
			} else if (ts.isShorthandPropertyAssignment(property)) {
				if (!names.has(property.name.text)) return unavailable;
				result[property.name.text] = names.get(property.name.text);
			} else return unavailable;
		}
		return result;
	}
	if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
		const call = node.expression;
		const target = constant(call.expression, names);
		if (call.name.text === "repeat" && typeof target === "string" && node.arguments[0]) {
			const count = constant(node.arguments[0], names);
			if (typeof count === "number" && count >= 0 && count <= 100_000) return target.repeat(count);
		}
	}
	return unavailable;
}

/** Every constant JSON object/string in the provider unit tests supplements the generated corpus. */
export async function existingTestInputs(): Promise<readonly unknown[]> {
	const directory = new URL("../../../packages/adapters/test/providers/", import.meta.url);
	const values: unknown[] = [];
	for (const file of (await readdir(directory))
		.filter((file) => file.endsWith(".test.ts"))
		.sort()) {
		const source = ts.createSourceFile(
			file,
			await readFile(new URL(file, directory), "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const names = new Map<string, unknown>();
		const visit = (node: ts.Node): void => {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
				const value = constant(node.initializer, names);
				if (value !== unavailable) names.set(node.name.text, value);
			}
			if (ts.isObjectLiteralExpression(node) || ts.isStringLiteralLike(node)) {
				const value = constant(node, names);
				if (value !== unavailable) values.push(value);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return values;
}
