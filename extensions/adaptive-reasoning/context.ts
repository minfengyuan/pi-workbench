import { encode, decode, countTokens } from "gpt-tokenizer/encoding/o200k_base";

export interface EvaluatorState {
	model: string;
	supportedEfforts: string[];
	latestUserPrompt: string;
	priorUserPrompts: string[];
	publicNotes: string[];
	recentToolCalls: { name: string; arguments: string; result: string; isError: boolean }[];
	omittedOlderToolCalls: number;
	step: number;
	previousEffort: string;
	newToolFailures: number;
}
const TOKEN_OPTIONS = { disallowedSpecial: new Set<string>() };
const MARKER = "\n[Tool output truncated: middle omitted]\n";
export function truncateToolResult(text: string): string {
	const tokens = encode(text, TOKEN_OPTIONS);
	if (tokens.length <= 1000) return text;
	const available = 1000 - countTokens(MARKER, TOKEN_OPTIONS);
	let head = Math.floor(available / 2), tail = available - head;
	let result = decode(tokens.slice(0, head)) + MARKER + decode(tokens.slice(-tail));
	while (countTokens(result, TOKEN_OPTIONS) > 1000) {
		head--; tail--; result = decode(tokens.slice(0, head)) + MARKER + decode(tokens.slice(-tail));
	}
	return result;
}
function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}
export function buildEvaluatorState(messages: readonly unknown[], metadata: Omit<EvaluatorState, "priorUserPrompts" | "publicNotes" | "recentToolCalls" | "omittedOlderToolCalls">): EvaluatorState {
	const users: string[] = [], notes: string[] = [];
	const calls: { id: string; name: string; arguments: unknown }[] = [];
	const results = new Map<string, { content: unknown; isError: boolean }>();
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const m = raw as Record<string, any>;
		if (m.role === "user") users.push(textContent(m.content));
		if (m.role === "assistant") {
			const text = textContent(m.content); if (text) notes.push(text);
			if (Array.isArray(m.content)) for (const block of m.content) {
				if (block?.type === "toolCall") calls.push({ id: String(block.id), name: String(block.name), arguments: block.arguments ?? {} });
			}
		}
		if (m.role === "toolResult") results.set(String(m.toolCallId), { content: m.content, isError: m.isError === true });
	}
	return { ...metadata, priorUserPrompts: users.filter((p, i) => !(i === users.length - 1 && p === metadata.latestUserPrompt)), publicNotes: notes,
		recentToolCalls: calls.slice(-6).map(({ id, name, arguments: args }) => ({ name, arguments: truncateToolResult(JSON.stringify(args)), result: truncateToolResult(textContent(results.get(id)?.content)), isError: results.get(id)?.isError ?? false })), omittedOlderToolCalls: Math.max(0, calls.length - 6) };
}
export function serializeRequest(request: unknown): string {
	const body = JSON.stringify(request);
	if (Buffer.byteLength(body) > 2_100_000 || countTokens(body, TOKEN_OPTIONS) > 28_000) throw new Error("Evaluator context exceeds local budget");
	return body;
}
