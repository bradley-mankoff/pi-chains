/**
 * The outside service the Chains tests talk to: pi providers that answer each request with
 * the model's name and record which provider, model and thinking level each request
 * reached in CHAINS_TEST_LOG, one JSON object a line.
 *
 * The Chains extension is the code under test. This file stands in for the real providers
 * at the edge of the system, so a test can see which account each request reached without
 * spending an account or reading inside the extension. Each provider is one account, as
 * codex-a, codex-b, claude-bridge and opencode-go are on the Mac, and test is
 * the plain provider the first Chains tests use.
 *
 * CHAINS_TEST_FAILURES names a JSON object from "provider/model" to a failure: a string
 * makes every request to that model fail with that message; {message, times} makes only the
 * first `times` requests fail, for a transient error pi retries; {message, after} lets the
 * first `after` requests answer, for an account that runs out mid-session.
 */
import { appendFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const api = "chains-test";
const log = process.env.CHAINS_TEST_LOG ?? "/dev/null";

type Failure = string | { message: string; times?: number; after?: number };

const failures: Record<string, Failure> = (() => {
	const path = process.env.CHAINS_TEST_FAILURES;
	if (!path) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, Failure>;
	} catch {
		return {};
	}
})();

/** How many requests each model has had in this process, so a transient failure can pass. */
const attempts = new Map<string, number>();

const model = (id: string, thinkingLevelMap: Record<string, string | null> = { max: "max" }) => ({
	id,
	name: id[0].toUpperCase() + id.slice(1),
	reasoning: true,
	// The levels this model offers, as pi's catalog maps them: a level missing from the map
	// falls back to its own name, and a null means the model has no such level.
	thinkingLevelMap,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
});

const message = (requested: Model<Api>, rest: Partial<AssistantMessage>): AssistantMessage => ({
	role: "assistant",
	content: [],
	api: requested.api,
	provider: requested.provider,
	model: requested.id,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
	...rest,
});

/** The message a model fails with this time, if any. */
const failureFor = (requested: Model<Api>): string | undefined => {
	const key = `${requested.provider}/${requested.id}`;
	const failure = failures[key];
	const attempt = (attempts.get(key) ?? 0) + 1;
	attempts.set(key, attempt);
	if (typeof failure === "string") return failure;
	if (!failure) return undefined;
	const first = (failure.after ?? 0) + 1;
	return attempt >= first && attempt < first + (failure.times ?? Number.POSITIVE_INFINITY) ? failure.message : undefined;
};

export default function testProvider(pi: ExtensionAPI): void {
	const streamSimple = (requested: Model<Api>, _context: unknown, options?: SimpleStreamOptions) => {
		appendFileSync(
			log,
			`${JSON.stringify({ provider: requested.provider, model: requested.id, reasoning: options?.reasoning ?? null })}\n`,
		);
		const errorMessage = failureFor(requested);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if (errorMessage !== undefined) {
				stream.push({ type: "error", reason: "error", error: message(requested, { stopReason: "error", errorMessage }) });
				return;
			}
			const text = `answered by ${requested.id}`;
			const answer = message(requested, { content: [{ type: "text", text }] });
			stream.push({ type: "start", partial: answer });
			stream.push({ type: "text_start", contentIndex: 0, partial: answer });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: answer });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: answer });
			stream.push({ type: "done", reason: "stop", message: answer });
		});
		return stream;
	};

	// One provider per account, so a mark on one account cannot hide another's models. The
	// opencode-go and claude-bridge lists hold the models the personal Mac's Chains name, with
	// the levels pi's catalog gives them: Muse Spark 1.3 tops out at xhigh, DeepSeek v4.1 Flash
	// offers max.
	const accounts: Record<string, ReturnType<typeof model>[]> = {
		test: [model("alpha"), model("beta")],
		"codex-a": [model("terra"), model("luna")],
		"codex-b": [model("terra"), model("sol")],
		"claude-bridge": [model("opus"), model("claude-opus-5-5")],
		"opencode-go": [
			model("flash"),
			model("deepseek-v4.1-flash"),
			model("muse-spark-1.3-contributor", { xhigh: "xhigh", max: null }),
		],
	};
	for (const [provider, models] of Object.entries(accounts)) {
		pi.registerProvider(provider, {
			name: `Chains test provider: ${provider}`,
			api,
			apiKey: "test-key",
			baseUrl: "http://localhost:0",
			models,
			streamSimple,
		});
	}
}
