import { encode, decode, countTokens } from "gpt-tokenizer/encoding/o200k_base";

export interface EvaluatorState {
	model: string;
	supportedEfforts: string[];
	latestUserPrompt: string;
	priorUserPrompts: string[];
	omittedOlderUserPrompts: number;
	publicNotes: string[];
	omittedOlderPublicNotes: number;
	recentToolCalls: { name: string; arguments: string; result: string; isError: boolean }[];
	omittedOlderToolCalls: number;
	step: number;
	previousEffort: string;
	newToolFailures: number;
}
type ProjectedFields = "priorUserPrompts" | "omittedOlderUserPrompts" | "publicNotes" | "omittedOlderPublicNotes" | "recentToolCalls" | "omittedOlderToolCalls";

/** Local o200k_base token budgets. Newest content is kept; older content is counted, not sent. */
export const CONTEXT_BUDGETS = {
	latestUserPrompt: 4_000,
	priorUserPrompts: 3_000,
	publicNotes: 4_000,
	historyItem: 1_000,
	toolPreview: 1_000,
	recentToolCalls: 6,
	/** Serialized state; leaves headroom below the 28,000-token request limit for questions/metadata. */
	stateTokens: 26_000,
	stateBytes: 2_000_000,
} as const;
const REQUEST_TOKENS = 28_000, REQUEST_BYTES = 2_100_000;
const MIN_ITEM_TOKENS = 64;
const TOKEN_OPTIONS = { disallowedSpecial: new Set<string>() };
const TOOL_MARKER = "\n[Tool output truncated: middle omitted]\n";
const TEXT_MARKER = "\n[Text truncated: middle omitted]\n";

/** Keep head and tail within `limit` local tokens, marking the omitted middle. */
export function truncateMiddle(text: string, limit: number, marker = TEXT_MARKER): string {
	const tokens = encode(text, TOKEN_OPTIONS);
	if (tokens.length <= limit) return text;
	const join = (head: number, tail: number) => decode(tokens.slice(0, Math.max(0, head))) + marker + (tail > 0 ? decode(tokens.slice(-tail)) : "");
	const available = limit - countTokens(marker, TOKEN_OPTIONS);
	if (available <= 0) return marker.trim();
	let head = Math.ceil(available / 2), tail = available - head;
	let result = join(head, tail);
	while ((head > 0 || tail > 0) && countTokens(result, TOKEN_OPTIONS) > limit) {
		if (head >= tail) head--; else tail--;
		result = join(head, tail);
	}
	return result;
}
export function truncateToolResult(text: string): string {
	return truncateMiddle(text, CONTEXT_BUDGETS.toolPreview, TOOL_MARKER);
}
/** Select newest items first under a shared token budget; returned items stay chronological. */
export function newestWithinBudget(items: readonly string[], totalTokens: number, itemTokens: number = CONTEXT_BUDGETS.historyItem): { kept: string[]; omitted: number } {
	const kept: string[] = [];
	let remaining = totalTokens;
	for (let i = items.length - 1; i >= 0 && remaining >= MIN_ITEM_TOKENS; i--) {
		const text = truncateMiddle(items[i], Math.min(itemTokens, remaining));
		kept.unshift(text);
		remaining -= countTokens(text, TOKEN_OPTIONS);
	}
	return { kept, omitted: items.length - kept.length };
}
function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}
function overStateBudget(state: EvaluatorState): boolean {
	const json = JSON.stringify(state);
	return Buffer.byteLength(json) > CONTEXT_BUDGETS.stateBytes || countTokens(json, TOKEN_OPTIONS) > CONTEXT_BUDGETS.stateTokens;
}
/**
 * Build bounded evaluator context from Pi's projected, model-visible messages.
 * Only user text, public assistant text blocks and recent tool previews are used;
 * thinking, images, headers and other message fields are never copied.
 */
export function buildEvaluatorState(messages: readonly unknown[], metadata: Omit<EvaluatorState, ProjectedFields>): EvaluatorState {
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
	if (users.at(-1) === metadata.latestUserPrompt) users.pop();
	const prior = newestWithinBudget(users.filter((text) => text.length > 0), CONTEXT_BUDGETS.priorUserPrompts);
	const publicNotes = newestWithinBudget(notes, CONTEXT_BUDGETS.publicNotes);
	const recent = calls.slice(-CONTEXT_BUDGETS.recentToolCalls);
	const state: EvaluatorState = {
		...metadata,
		latestUserPrompt: truncateMiddle(metadata.latestUserPrompt, CONTEXT_BUDGETS.latestUserPrompt),
		priorUserPrompts: prior.kept, omittedOlderUserPrompts: prior.omitted,
		publicNotes: publicNotes.kept, omittedOlderPublicNotes: publicNotes.omitted,
		recentToolCalls: recent.map(({ id, name, arguments: args }) => ({ name, arguments: truncateToolResult(JSON.stringify(args)), result: truncateToolResult(textContent(results.get(id)?.content)), isError: results.get(id)?.isError ?? false })),
		omittedOlderToolCalls: calls.length - recent.length,
	};
	// Escaping or byte-heavy tokens can still overflow; shed oldest history first.
	// If only the latest prompt and metadata remain, serializeRequest fails closed.
	let dropNote = true;
	while (overStateBudget(state)) {
		const note = state.publicNotes.length > 0 && (dropNote || state.priorUserPrompts.length === 0);
		if (note) { state.publicNotes.shift(); state.omittedOlderPublicNotes++; }
		else if (state.priorUserPrompts.length) { state.priorUserPrompts.shift(); state.omittedOlderUserPrompts++; }
		else if (state.recentToolCalls.length) { state.recentToolCalls.shift(); state.omittedOlderToolCalls++; }
		else break;
		dropNote = !dropNote;
	}
	return state;
}
export function serializeRequest(request: unknown): string {
	const body = JSON.stringify(request);
	if (Buffer.byteLength(body) > REQUEST_BYTES || countTokens(body, TOKEN_OPTIONS) > REQUEST_TOKENS) throw new Error("Evaluator context exceeds local budget");
	return body;
}
