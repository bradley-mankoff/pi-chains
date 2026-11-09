/**
 * chains: one selectable pi model per role, each running on its Chain.
 *
 * A Chain is the ordered list of models one role runs on, each with its thinking level
 * (GLOSSARY.md, fac-qpv.1). This extension reads the Chains file from pi's agent folder,
 * <agent dir>/chains.json, and registers one virtual model per role under the "chain"
 * provider, such as chain/pm, chain/spec-review, chain/work and chain/scout. pi records the
 * virtual model as the session's selection and the physical model on every assistant
 * message, so a session shows which model actually answered.
 *
 * A request goes to the first entry whose account has usage left, and stays on the seat
 * that answered last while its account has usage, so a session keeps its prompt cache. An
 * entry names one model on one account, "provider/model", or one model on a group of seats
 * (GLOSSARY.md, `Seat`), written with "seats": when a session's seat runs out it moves to
 * the same model on the next seat of the group, and only when every seat is used up does it
 * move down the Chain. A new session starts on the seat its turn names; the turns are
 * counted in the shared file, so sessions in different processes alternate, and the session
 * keeps its turn on its branch, so a retry or a fallback inside it takes no new turn.
 *
 * A mark is per account, not per model (GLOSSARY.md, `Account`): models on one login share
 * its limit. When a request fails because the account has run out, this extension marks that
 * account used up in ${XDG_STATE_HOME:-~/.local/state}/pi-chains/accounts.json, shared by
 * every pi session on the Mac, with the reset time the provider's message gives or one hour
 * when it gives none. It then continues the session from agent_before_settle, so the next
 * request goes to the next seat or the next entry of the Chain; an expired mark is ignored.
 * When no entry is left, the request fails with a message naming each account and its reset
 * time.
 *
 * Every role's model is registered once, when pi loads this extension, and never from a
 * session handler: a handler that calls pi.* breaks the next node of a Run, because Archon
 * shares one loaded extension between its nodes (pi-agent/README.md). The settle handler
 * reads the handler's ctx and the shared file only. So a Run's nodes share the Chains its
 * extension loaded, and a role added to the file is selectable from the next pi process,
 * which is the next Run.
 *
 * A broken file never stops a session: the extension reports it and the session keeps the
 * model it was going to use. A Mac with no file has no role to select until one is there.
 *
 * The file is a JSON object from a role to its Chain:
 *
 *   {
 *     "pm": [
 *       { "model": "claude-bridge/claude-opus-5-5", "thinking": "medium" },
 *       { "model": "gpt-6.1-sol", "thinking": "high", "seats": ["codex-a", "codex-b"] }
 *     ]
 *   }
 *
 * An entry's model is "provider/model", the provider first, so a model id may itself contain
 * slashes; an entry with "seats" names the model alone, because every seat serves it. The
 * accounts file is a JSON object whose "accounts" holds each used-up provider and when it
 * resets, { "accounts": { "codex-a": { "resetsAt": "..." } } }, and whose "seatTurns"
 * counts the sessions that have started on a seat.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// The levels are copied from pi-ai's ModelThinkingLevel rather than imported: it lives in
// the package's providers/model-schema subpath, not its root, and an extension that fails to
// load breaks every node of a Run. A pi upgrade that adds a level must add it here too.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/**
 * One entry of a Chain (GLOSSARY.md): one model at one thinking level, reached through one or
 * more seats. A plain entry has one seat, its provider; a seat group has one login per seat.
 */
type Entry = { model: string; thinking: ThinkingLevel; seats: string[] };
type Chain = Entry[];
type Chains = Record<string, Chain>;
/** Where one seat sits in a Chain: the entry, and the seat within it. */
type SeatRef = { entry: number; seat: number };
/** When an account's usage comes back, in epoch milliseconds. */
type Mark = number;
type Marks = Record<string, Mark>;

const HOUR = 60 * 60 * 1000;

/**
 * The Chains file: pi's agent folder, PI_CODING_AGENT_DIR when set and ~/.pi/agent otherwise.
 */
const chainsPath = (): string =>
	join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "chains.json");
/** The Mac's used-up account marks: one file for every pi session, whatever its agent folder. */
const accountsPath = (): string =>
	join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-chains", "accounts.json");

/**
 * The final usage-limit messages the providers send (tests/fixtures/usage-limits.json has
 * each one and where it came from). A rate-limit warning such as Claude's
 * "Claude subscription rate limit reached (five_hour) — resets at 7:30:00 PM" is not here:
 * the bridge sends it before the account is used up, and pi retries it normally.
 */
const USAGE_LIMIT_MESSAGES: RegExp[] = [
	// Codex's "The usage limit has been reached", and OpenCode Go's "Monthly usage limit reached".
	/usage limit/i,
	// claude-bridge's final message.
	/quota exceeded/i,
	/spend limit/i,
	// The error types in pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN, and the
	// available-balance text its comment names for OpenCode Go's rolling and weekly limits.
	/GoUsageLimitError|FreeUsageLimitError|available balance/i,
];

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read one entry of the file. A plain entry splits its "provider/model" and rejects an empty
 * side; a seat group names the one model and the seats that share it, so its model carries no
 * provider.
 */
const readEntry = (value: unknown): Entry | undefined => {
	if (!isObject(value)) return undefined;
	const { model, thinking, seats } = value;
	if (typeof model !== "string" || typeof thinking !== "string") return undefined;
	if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) return undefined;
	if (seats === undefined) {
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1) return undefined;
		return {
			seats: [model.slice(0, slash)],
			model: model.slice(slash + 1),
			thinking: thinking as ThinkingLevel,
		};
	}
	if (model.includes("/") || !Array.isArray(seats)) return undefined;
	const named = seats.filter((seat): seat is string => typeof seat === "string" && seat.length > 0);
	const unique = [...new Set(named)];
	if (unique.length < 2 || unique.length !== seats.length) return undefined;
	return { seats: unique, model, thinking: thinking as ThinkingLevel };
};

/**
 * Where a physical model sits in a Chain, if it sits in one: the account that answered names its
 * seat.
 */
const seatRefOf = (entries: Chain, answered: { provider: string; model: string }): SeatRef | undefined => {
	for (const [entry, item] of entries.entries()) {
		const seat = item.seats.indexOf(answered.provider);
		if (seat >= 0 && item.model === answered.model) return { entry, seat };
	}
	return undefined;
};

/** The account a seat is reached through: each seat names one login. */
const accountAt = (entries: Chain, at: SeatRef): string => entries[at.entry].seats[at.seat];

/** Read one role's Chain, or the reason it is not one: the role's value and each entry fail differently. */
const readChain = (role: string, value: unknown): { entries: Chain } | { problem: string } => {
	const entryShape = `{model: "provider/model", thinking: one of ${THINKING_LEVELS.join(", ")}} or {model: "model", thinking: one of ${THINKING_LEVELS.join(", ")}, seats: ["account", "account"]}`;
	if (!Array.isArray(value) || value.length === 0) {
		return { problem: `"${role}" is not a non-empty list; a Chain is a list of ${entryShape}` };
	}
	const entries: Chain = [];
	for (const [index, item] of value.entries()) {
		const entry = readEntry(item);
		if (!entry) return { problem: `entry ${index + 1} of "${role}" is not ${entryShape}` };
		entries.push(entry);
	}
	return { entries };
};

/**
 * Read a file of one JSON object, or the reason it is not one. A missing file is an empty
 * object: before a Mac has the file, it runs on its defaults.
 */
const readJsonObject = (path: string): { file: Record<string, unknown> } | { problem: string } => {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: {} };
		return { problem: `cannot read ${path}: ${(error as Error).message}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { problem: `${path} is not valid JSON: ${(error as Error).message}` };
	}
	return isObject(parsed) ? { file: parsed } : { problem: `${path} must be a JSON object` };
};

const readChains = (path: string): { chains: Chains; errors: string[] } => {
	const read = readJsonObject(path);
	if ("problem" in read) return { chains: {}, errors: [`chains: ${read.problem}`] };
	const chains: Chains = {};
	const errors: string[] = [];
	for (const [role, value] of Object.entries(read.file)) {
		// One bad role does not take the other Chains with it.
		const chain = readChain(role, value);
		if ("problem" in chain) {
			errors.push(`chains: ${path} ${chain.problem}`);
			continue;
		}
		chains[role] = chain.entries;
	}
	return { chains, errors };
};

// One report per process, so a broken file does not fill a Run's log on every request.
const reported = new Set<string>();
const reportOnce = (problem: string): void => {
	if (reported.has(problem)) return;
	reported.add(problem);
	console.error(problem);
};

/** Read the accounts file's unparsed contents, so a write keeps any other fields in it. */
const readAccountsFile = (): Record<string, unknown> => {
	const read = readJsonObject(accountsPath());
	if (!("problem" in read)) return read.file;
	reportOnce(`chains: ${read.problem}; treating every account as having usage`);
	return {};
};

/** One account's mark from the file, or undefined when the value is not a readable reset time. */
const readMark = (value: unknown): Mark | undefined => {
	if (!isObject(value) || typeof value.resetsAt !== "string") return undefined;
	const resetsAt = Date.parse(value.resetsAt);
	return Number.isFinite(resetsAt) ? resetsAt : undefined;
};

const marksOf = (file: Record<string, unknown>): Marks => {
	if (!isObject(file.accounts)) return {};
	const marks: Marks = {};
	for (const [account, value] of Object.entries(file.accounts)) {
		const mark = readMark(value);
		if (mark !== undefined) marks[account] = mark;
	}
	return marks;
};

const isUsedUp = (marks: Marks, account: string, now: number): boolean =>
	marks[account] !== undefined && marks[account] > now;

/** Replace the shared file in one move, so another agent never reads half of it. */
const writeSharedFile = (file: Record<string, unknown>): void => {
	const path = accountsPath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`);
	renameSync(temp, path);
};

/** Mark one account used up, keeping the other accounts and fields, and dropping expired marks. */
const markUsedUp = (account: string, resetsAt: Mark): void => {
	const file = readAccountsFile();
	const accounts = isObject(file.accounts) ? { ...file.accounts } : {};
	const now = Date.now();
	for (const [key, value] of Object.entries(accounts)) {
		const mark = readMark(value);
		if (mark === undefined || mark <= now) delete accounts[key];
	}
	accounts[account] = { resetsAt: new Date(resetsAt).toISOString() };
	writeSharedFile({ ...file, accounts });
};

/** A turn, or a count of turns, as the shared file and the branch store it: a whole number from zero. */
const readTurn = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * The Mac's count of sessions that started on a seat, and this session's turn at them. The
 * count lives in the shared file so sessions in different processes take turns; a session's
 * turn is the count's value before its own, and two seats give alternate turns. Two sessions
 * that start at the same instant can take the same turn, which costs a turn's evenness and
 * never a session's work.
 */
const takeTurn = (): number => {
	const file = readAccountsFile();
	const turns = readTurn(file.seatTurns) ?? 0;
	try {
		writeSharedFile({ ...file, seatTurns: turns + 1 });
	} catch (error) {
		reportOnce(`chains: cannot write the seat turns to ${accountsPath()}: ${(error as Error).message}`);
	}
	return turns;
};

/** The wall clock a time zone shows at an instant, in pieces. */
const zoneParts = (
	date: Date,
	timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } => {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(date);
	const part = (type: string): number => Number(parts.find((piece) => piece.type === type)?.value);
	return {
		year: part("year"),
		month: part("month"),
		day: part("day"),
		hour: part("hour"),
		minute: part("minute"),
		second: part("second"),
	};
};

/** How far the zone's clock is from UTC at an instant, in milliseconds. */
const zoneOffset = (date: Date, timeZone: string): number => {
	const parts = zoneParts(date, timeZone);
	return (
		Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
		Math.floor(date.getTime() / 1000) * 1000
	);
};

/** The instant at which the zone's clock reads this wall time. */
const zonedTime = (year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date => {
	const wall = Date.UTC(year, month - 1, day, hour, minute);
	let at = wall - zoneOffset(new Date(wall), timeZone);
	// A second pass lands the right side of a daylight-saving change.
	at = wall - zoneOffset(new Date(at), timeZone);
	return new Date(at);
};

/**
 * The time zone a message names in parentheses, when it names a real one, else this Mac's
 * zone: a parenthesis with a slash in it is not necessarily a time zone.
 */
const zoneOf = (message: string): string => {
	const local = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
	const named = /\(([A-Za-z]+\/[A-Za-z_+-]+)\)/.exec(message)?.[1];
	if (!named) return local;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: named });
		return named;
	} catch {
		return local;
	}
};

/** When usage comes back: the time the provider's message names, else one hour from now. */
const resetAfter = (message: string, now: number): number => {
	const clock = /resets?(?:\s+at)?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)/i.exec(message);
	if (!clock) return now + HOUR;
	const timeZone = zoneOf(message);
	const today = zoneParts(new Date(now), timeZone);
	const hour = (Number(clock[1]) % 12) + (clock[3].toLowerCase() === "pm" ? 12 : 0);
	const minute = Number(clock[2]);
	let at = zonedTime(today.year, today.month, today.day, hour, minute, timeZone);
	if (at.getTime() <= now) at = zonedTime(today.year, today.month, today.day + 1, hour, minute, timeZone);
	return at.getTime();
};

const isUsageLimit = (message: string): boolean => USAGE_LIMIT_MESSAGES.some((pattern) => pattern.test(message));

/** The turn a session already took, when the state pi keeps on its branch holds one. */
const turnOf = (state: unknown): number | undefined => (isObject(state) ? readTurn(state.turn) : undefined);

const register = (pi: ExtensionAPI, path: string, role: string, entries: Chain): void => {
	const usedUpMessage = (marks: Marks): string =>
		`chain/${role} is used up: ${[...new Set(entries.flatMap((entry) => entry.seats))]
			.map((account) => `${account} resets at ${new Date(marks[account]).toISOString()}`)
			.join("; ")}`;

	pi.registerVirtualModel<{ turn: number }>({
		provider: "chain",
		id: role,
		// The role names the model, so the Chains file stays the one place the roles are listed.
		name: `Chain: ${role}`,
		thinkingLevels: [entries[0].thinking],
		route(request, ctx) {
			const now = Date.now();
			const marks = marksOf(readAccountsFile());
			// Whether the account behind one seat has usage at this instant.
			const hasUsage = (at: SeatRef): boolean => !isUsedUp(marks, accountAt(entries, at), now);
			// The model that answered last, or the one a retry failed on. Staying on it keeps the
			// prompt cache, and a retry on the session's first request keeps the seat it started on.
			const last = (request.reason === "retry" ? request.failed?.model : undefined) ?? request.previous?.model;
			const previous = last ? seatRefOf(entries, { provider: last.provider, model: last.id }) : undefined;
			// This session's turn at the seats, kept with the session so every request of it agrees:
			// a retry, or a fallback to the other seat, takes no new turn. It is taken from the
			// shared file the first time the session reaches an entry with more than one seat.
			const taken = turnOf(request.state);
			let turn = taken;
			const seatToStart = (entry: number): number => {
				if (entries[entry].seats.length === 1) return 0;
				turn ??= takeTurn();
				return turn % entries[entry].seats.length;
			};
			// Stay on the seat that answered last while its account has usage: switching costs the
			// prompt cache. Once it runs out, try the entry's other seats, which keep the same
			// model, then the Chain's later entries, then round the Chain again in case a mark expired.
			let chosen = previous && hasUsage(previous) ? previous : undefined;
			if (chosen === undefined) {
				const order: SeatRef[] = [];
				const first = previous ? previous.entry : 0;
				for (let i = 0; i < entries.length; i++) {
					const entry = (first + i) % entries.length;
					const from = previous && entry === previous.entry ? previous.seat + 1 : seatToStart(entry);
					for (let j = 0; j < entries[entry].seats.length; j++) {
						order.push({ entry, seat: (from + j) % entries[entry].seats.length });
					}
				}
				chosen = order.find(hasUsage);
			}
			if (chosen === undefined) throw new Error(usedUpMessage(marks));
			const entry = entries[chosen.entry];
			const account = accountAt(entries, chosen);
			const model = ctx.modelRegistry.find(account, entry.model);
			if (!model) {
				throw new Error(
					`chains: ${path} gives "${role}" the model ${account}/${entry.model}, which this Mac does not have; add that provider's login or name another model`,
				);
			}
			// Store the turn only when this request takes it: every later request of the session reads
			// it back from the branch, and a request that already had it leaves the state alone.
			const state = turn !== undefined && turn !== taken ? { turn } : undefined;
			return { model, thinkingLevel: entry.thinking, state };
		},
	});
};

/**
 * Mark an account whose final error says it ran out, then ask pi for one more request so
 * the next seat or the next entry answers. The models are already registered; this handler
 * only reads ctx and files, never pi.*.
 */
const onBeforeSettle = (
	event: AgentBeforeSettleEvent,
	ctx: ExtensionContext,
	registered: Chains,
): AgentBeforeSettleEventResult | undefined => {
	if (event.outcome !== "error") return undefined;
	const model = ctx.model;
	if (!model || model.provider !== "chain") return undefined;
	const entries = registered[model.id];
	if (!entries) return undefined;
	const last = [...event.context.contextMessages].reverse().find((message) => message.role === "assistant");
	if (!last || last.role !== "assistant" || last.stopReason !== "error" || !last.errorMessage) return undefined;
	if (!isUsageLimit(last.errorMessage)) return undefined;
	const seat = seatRefOf(entries, last);
	if (!seat) return undefined;
	const account = accountAt(entries, seat);
	const mark = resetAfter(last.errorMessage, Date.now());
	try {
		markUsedUp(account, mark);
	} catch (error) {
		// Without the mark the next request would reach the same used-up account again.
		console.error(`chains: cannot mark ${account} used up in ${accountsPath()}: ${(error as Error).message}; stopping`);
		return undefined;
	}
	const resetsAt = new Date(mark).toISOString();
	console.error(`chains: ${account} is used up until ${resetsAt}; continuing on chain/${model.id}, on the next seat or the next entry`);
	return {
		entries: [
			{
				type: "custom_message",
				customType: "chains",
				content: `chain/${model.id}: the account ${account} is used up until ${resetsAt}. Carry on with the work; the session continues on the same model on the next seat, and moves down the Chain only when every seat is used up.`,
				display: true,
			},
		],
		continue: true,
	};
};

export default function chains(pi: ExtensionAPI): void {
	const path = chainsPath();
	const { chains, errors } = readChains(path);
	for (const [role, entries] of Object.entries(chains)) register(pi, path, role, entries);
	for (const error of errors) console.error(error);

	pi.on("agent_before_settle", (event, ctx) => onBeforeSettle(event, ctx, chains));
}
