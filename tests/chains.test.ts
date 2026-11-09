/**
 * A Chain is the ordered list of models one role runs on (GLOSSARY.md, fac-qpv.1).
 * These tests drive the seam the Chains Spec names: a pi session in print mode with
 * the Chains extension loaded, a temporary Chains file, and a provider at the edge
 * that records which physical model each request reached.
 *
 * The account marks, the seat turns and the usage-limit messages live in files a test can
 * read after a session, because other agents on the Mac read the same ones: HOME is the
 * temporary home of one "Mac", and two sessions there share its marks and its turns.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chainsExtension = join(root, "extensions", "chains.ts");
const testProvider = join(root, "tests", "fixtures", "test-provider.ts");

const chains = {
	pm: [{ model: "test/alpha", thinking: "medium" }],
	"spec-review": [{ model: "test/alpha", thinking: "medium" }],
	work: [
		{ model: "test/alpha", thinking: "high" },
		{ model: "test/beta", thinking: "max" },
	],
	scout: [{ model: "test/alpha", thinking: "max" }],
};

type Request = { provider: string; model: string; reasoning: string | null };
/** One line of a pi session file. */
type SessionLine = {
	type: string;
	provider?: string;
	modelId?: string;
	content?: string;
	message?: {
		role: string;
		provider?: string;
		model?: string;
		thinkingLevel?: string;
		stopReason?: string;
		errorMessage?: string;
	};
};

/** One account's message, recorded beside the tests with where it came from. */
type RecordedLimit = {
	id: string;
	account: string;
	model: string;
	fallback: { account: string; model: string };
	message: string;
	reset: { kind: "one-hour" } | { kind: "clock"; hour: number; minute: number; timeZone: string };
	source: string;
};
const recordedLimits = JSON.parse(readFileSync(join(root, "tests", "fixtures", "usage-limits.json"), "utf8")) as RecordedLimit[];

/** One recorded usage-limit message by id; the fixtures file holds where each came from. */
const limitFor = (id: string): RecordedLimit => {
	const limit = recordedLimits.find((entry) => entry.id === id);
	assert.ok(limit, `tests/fixtures/usage-limits.json has no usage-limit message with id "${id}"`);
	return limit;
};

const chainFor = (limit: RecordedLimit) => [
	{ model: `${limit.account}/${limit.model}`, thinking: "high" },
	{ model: `${limit.fallback.account}/${limit.fallback.model}`, thinking: "max" },
];

/**
 * An entry of a Chain that names its seats as a group (GLOSSARY.md, `Seat`): one model,
 * reached through any of the group's logins to the same provider.
 */
const seatsEntry = (model: string, seats: string[], thinking = "high") => ({ model, seats, thinking });
/** The two ChatGPT seats, as the work Mac's Chains name them. */
const SEATS = ["codex-a", "codex-b"];
/** Both seats failing on one model, each with its own login's recorded usage-limit message. */
const bothSeatsUsedUp = (model: string): Record<string, string> =>
	Object.fromEntries(SEATS.map((seat) => [`${seat}/${model}`, limitFor(seat).message]));

/** What one pi process printed, asked its provider, and wrote to its session and the Mac's marks. */
type PiOutput = {
	status: number | null;
	stdout: string;
	stderr: string;
	requests: Request[];
	session: SessionLine[];
	/** The accounts marked used up on this Mac, from the shared file, by provider to reset time. */
	accounts: Record<string, string>;
};

type Options = {
	/** The Chains file's contents; invalid text stands in for a bad edit. */
	chainsFile?: string;
	/** Leave PI_CODING_AGENT_DIR unset, so pi reads its default agent folder, ~/.pi/agent. */
	useDefaultAgentDir?: boolean;
	/** Load the extension the way an AI node of a Run does, from the agent folder's extensions/. */
	fromPiFolder?: boolean;
	/** The session is expected to fail, as it does when its Chain names a model this Mac lacks. */
	expectFailure?: boolean;
	/** Account marks to put in the shared file before the session starts. */
	accounts?: Record<string, string>;
	/** The turn count to put in the shared file, as the Mac's earlier sessions left it. */
	seatTurns?: number;
	/** What the test provider fails with, by "provider/model"; a string fails every request. */
	failures?: Record<string, string | { message: string; times?: number; after?: number }>;
	/** pi's settings.json, for a test that needs its retry to finish quickly. */
	settings?: Record<string, unknown>;
	/** The test Mac's state folder, relative to its work folder, when a test sets XDG_STATE_HOME. */
	stateHome?: string;
	/** The agent folder this session uses, when it differs from the workspace's. */
	agentDir?: string;
};

/** One temporary Mac: a HOME, an agent folder, and the files the test provider and the Chains read. */
type Workspace = {
	dir: string;
	home: string;
	agentDir: string;
	chainsFile: string;
	/** The state folder the session's XDG_STATE_HOME names, when a test sets one. */
	stateHome?: string;
	runs: number;
};

/** The Mac's used-up account marks: XDG_STATE_HOME when a test sets one, else ~/.local/state. */
const accountsPath = (workspace: Workspace): string =>
	join(workspace.stateHome ?? join(workspace.home, ".local", "state"), "pi-chains", "accounts.json");

/** Write the shared file's marks and turn count in the shape the extension reads, as an earlier session left it. */
const writeAccounts = (path: string, accounts: Record<string, string>, seatTurns?: number): void => {
	mkdirSync(dirname(path), { recursive: true });
	const marks = Object.fromEntries(Object.entries(accounts).map(([account, resetsAt]) => [account, { resetsAt }]));
	writeFileSync(path, JSON.stringify({ ...(seatTurns === undefined ? {} : { seatTurns }), accounts: marks }));
};

const sessionFiles = (dir: string): string[] =>
	existsSync(dir)
		? readdirSync(dir, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
				.map((entry) => join(entry.parentPath, entry.name))
		: [];

/** Read a file of one JSON value a line, as pi writes a session and the test provider its log. */
const readJsonLines = <T>(path: string): T[] =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as T)
		: [];

const makeWorkspace = (options: Options = {}): Workspace => {
	const dir = mkdtempSync(join(tmpdir(), "pi-chains-"));
	const home = join(dir, "home");
	const agentDir = options.useDefaultAgentDir ? join(home, ".pi", "agent") : join(dir, "pi-agent");
	const chainsFile = join(agentDir, "chains.json");
	const stateHome = options.stateHome ? join(dir, options.stateHome) : undefined;
	const workspace: Workspace = { dir, home, agentDir, chainsFile, stateHome, runs: 0 };
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(chainsFile, options.chainsFile ?? JSON.stringify(chains));
	if (options.accounts || options.seatTurns !== undefined) {
		writeAccounts(accountsPath(workspace), options.accounts ?? {}, options.seatTurns);
	}
	if (options.failures) writeFileSync(join(dir, "failures.json"), JSON.stringify(options.failures));
	if (options.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
	return workspace;
};

const runPiIn = (workspace: Workspace, args: string[], options: Options = {}): PiOutput => {
	const requestLog = join(workspace.dir, `requests-${workspace.runs++}.jsonl`);
	const agentDir = options.agentDir ?? workspace.agentDir;
	const sessionsBefore = new Set(sessionFiles(join(agentDir, "sessions")));
	// An AI node of a Run does not pass -e: it loads the extension from its agent
	// folder's extensions/, the way pi discovers an installed extension.
	const extensions = options.fromPiFolder ? ["-e", testProvider] : ["-ne", "-e", testProvider, "-e", chainsExtension];
	if (options.fromPiFolder) {
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		const link = join(agentDir, "extensions", "chains.ts");
		if (!existsSync(link)) symlinkSync(chainsExtension, link);
	}
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: workspace.home,
		PI_SKIP_VERSION_CHECK: "1",
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		CHAINS_TEST_LOG: requestLog,
		CHAINS_TEST_FAILURES: join(workspace.dir, "failures.json"),
	};
	if (options.useDefaultAgentDir) delete env.PI_CODING_AGENT_DIR;
	else env.PI_CODING_AGENT_DIR = agentDir;
	if (workspace.stateHome) env.XDG_STATE_HOME = workspace.stateHome;
	else delete env.XDG_STATE_HOME;
	const result = spawnSync("pi", ["-ns", ...extensions, ...args], {
		cwd: workspace.dir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env,
	});
	if (!options.expectFailure) assert.equal(result.status, 0, result.stderr || result.stdout);
	const requests = readJsonLines<Request>(requestLog);
	const created = sessionFiles(join(agentDir, "sessions")).filter((file) => !sessionsBefore.has(file));
	const session = created[0] ? readJsonLines<SessionLine>(created[0]) : [];
	return { status: result.status, stdout: result.stdout, stderr: result.stderr, requests, session, accounts: readAccounts(accountsPath(workspace)) };
};

/** The Mac's count of sessions that started on a seat, kept in the shared file with the marks. */
const readSeatTurns = (path: string): number | undefined => {
	if (!existsSync(path)) return undefined;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { seatTurns?: unknown };
	return typeof parsed.seatTurns === "number" ? parsed.seatTurns : undefined;
};

const readAccounts = (path: string): Record<string, string> => {
	if (!existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { accounts?: Record<string, { resetsAt?: unknown }> };
	return Object.fromEntries(
		Object.entries(parsed.accounts ?? {}).flatMap(([account, mark]) =>
			typeof mark?.resetsAt === "string" ? [[account, mark.resetsAt] as [string, string]] : [],
		),
	);
};

const runPi = (args: string[], options: Options = {}): PiOutput => {
	const workspace = makeWorkspace(options);
	try {
		return runPiIn(workspace, args, options);
	} finally {
		rmSync(workspace.dir, { recursive: true, force: true });
	}
};

/** The roles `pi --list-models chain` offers, read from its table of models. */
const listedRoles = (stdout: string): string[] =>
	stdout.split("\n").flatMap((line) => {
		const listed = /^chain\s+(\S+)/.exec(line);
		return listed ? [listed[1]] : [];
	});

/** The physical model each request reached, in order, as [provider, model, thinking level]. */
const assertReached = (run: PiOutput, expected: [string, string, string | null][]): void => {
	assert.deepEqual(
		run.requests.map((request) => [request.provider, request.model, request.reasoning]),
		expected,
	);
};

/** The marks the provider's message names, or one hour from now when it names none. */
const assertReset = (iso: string, reset: RecordedLimit["reset"]): void => {
	const at = Date.parse(iso);
	assert.ok(Number.isFinite(at), `${iso} is not a time`);
	if (reset.kind === "one-hour") {
		const minutes = (at - Date.now()) / 60_000;
		assert.ok(minutes > 55 && minutes < 65, `the reset in ${iso} is ${minutes.toFixed(1)} minutes away, not about an hour`);
		return;
	}
	assert.ok(at > Date.now(), `the reset in ${iso} is not in the future`);
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", { timeZone: reset.timeZone, hour: "numeric", minute: "numeric", hour12: true })
			.formatToParts(new Date(at))
			.map((part) => [part.type, part.value]),
	);
	assert.deepEqual(
		{ hour: Number(parts.hour), minute: Number(parts.minute), dayPeriod: parts.dayPeriod },
		{ hour: reset.hour % 12 || 12, minute: reset.minute, dayPeriod: reset.hour < 12 ? "AM" : "PM" },
	);
};

test("a session reads the Chains file from the agent folder PI_CODING_AGENT_DIR names", () => {
	const run = runPi(["-p", "--model", "chain/work", "say hello"], {
		chainsFile: JSON.stringify({ work: [{ model: "test/beta", thinking: "max" }] }),
	});
	assertReached(run, [["test", "beta", "max"]]);
});

test("a session with no PI_CODING_AGENT_DIR reads the Chains file from ~/.pi/agent", () => {
	const run = runPi(["-p", "--model", "chain/work", "say hello"], {
		chainsFile: JSON.stringify({ work: [{ model: "test/beta", thinking: "max" }] }),
		useDefaultAgentDir: true,
	});
	assertReached(run, [["test", "beta", "max"]]);
});

test("a Chain entry that names its seats as a group runs its model on a seat, at the entry's thinking level", () => {
	const run = runPi(["-p", "--model", "chain/work", "say hello"], {
		chainsFile: JSON.stringify({ work: [seatsEntry("terra", SEATS)] }),
	});
	assertReached(run, [["codex-a", "terra", "high"]]);
});

test("consecutive new sessions start on alternate seats, in different processes", () => {
	const workspace = makeWorkspace({ chainsFile: JSON.stringify({ work: [seatsEntry("terra", SEATS)] }) });
	try {
		const first = runPiIn(workspace, ["-p", "--model", "chain/work", "say hello"]);
		const second = runPiIn(workspace, ["-p", "--model", "chain/work", "say hello"]);
		const third = runPiIn(workspace, ["-p", "--model", "chain/work", "say hello"]);
		assertReached(first, [["codex-a", "terra", "high"]]);
		assertReached(second, [["codex-b", "terra", "high"]]);
		assertReached(third, [["codex-a", "terra", "high"]]);
	} finally {
		rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("a session keeps its seat for every request while that seat has usage, including a retry, and takes one turn", () => {
	const workspace = makeWorkspace({
		chainsFile: JSON.stringify({ work: [seatsEntry("terra", SEATS)] }),
		failures: { "codex-a/terra": { message: "provider overloaded: the server is busy", times: 1 } },
		settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } },
	});
	try {
		const run = runPiIn(workspace, ["-p", "--model", "chain/work", "say hello", "say goodbye"]);
		assertReached(run, [
			["codex-a", "terra", "high"],
			["codex-a", "terra", "high"],
			["codex-a", "terra", "high"],
		]);
		assert.equal(readSeatTurns(accountsPath(workspace)), 1);
	} finally {
		rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("a used-up seat moves the session to the same model on the other seat before it moves down the Chain", () => {
	const limit = limitFor("codex-a");
	const workspace = makeWorkspace({
		chainsFile: JSON.stringify({
			work: [seatsEntry(limit.model, SEATS), { model: "opencode-go/flash", thinking: "max" }],
		}),
		failures: { [`${limit.account}/${limit.model}`]: limit.message },
	});
	try {
		const run = runPiIn(workspace, ["-p", "--model", "chain/work", "say hello", "say goodbye"]);
		assertReached(run, [
			["codex-a", "terra", "high"],
			["codex-b", "terra", "high"],
			["codex-b", "terra", "high"],
		]);
		assert.deepEqual(Object.keys(run.accounts), ["codex-a"]);
		// A fallback is not a new session, so the Mac counted one turn.
		assert.equal(readSeatTurns(accountsPath(workspace)), 1);
	} finally {
		rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("the turn count in the shared file decides which seat the next new session starts on", () => {
	const run = runPi(["-p", "--model", "chain/work", "say hello"], {
		chainsFile: JSON.stringify({ work: [seatsEntry("terra", SEATS)] }),
		seatTurns: 1,
	});
	assertReached(run, [["codex-b", "terra", "high"]]);
});

test("only when both seats are used up does the session move down the Chain", () => {
	const run = runPi(["-p", "--model", "chain/work", "say hello"], {
		chainsFile: JSON.stringify({
			work: [seatsEntry("terra", SEATS), { model: "opencode-go/flash", thinking: "max" }],
		}),
		failures: bothSeatsUsedUp("terra"),
	});
	assertReached(run, [
		["codex-a", "terra", "high"],
		["codex-b", "terra", "high"],
		["opencode-go", "flash", "max"],
	]);
	assert.deepEqual(Object.keys(run.accounts).sort(), [...SEATS].sort());
});

test("when both seats are used up and no entry is left, the session stops naming each seat and its reset time", () => {
	const run = runPi(["-p", "--model", "chain/work", "say hello"], {
		chainsFile: JSON.stringify({ work: [seatsEntry("terra", SEATS)] }),
		failures: bothSeatsUsedUp("terra"),
		expectFailure: true,
	});
	assertReached(run, [
		["codex-a", "terra", "high"],
		["codex-b", "terra", "high"],
	]);
	assert.notEqual(run.status, 0);
	assert.match(run.stderr, /chain\/work is used up/);
	for (const seat of SEATS) assert.match(run.stderr, new RegExp(`${seat} resets at \\d{4}-`));
});

test("a seat that runs out mid-session moves the session to the same model on the other seat, and it stays there", () => {
	const run = runPi(["-p", "--model", "chain/work", "say hello", "say goodbye", "say again"], {
		chainsFile: JSON.stringify({
			work: [seatsEntry("terra", SEATS), { model: "opencode-go/flash", thinking: "max" }],
		}),
		failures: { "codex-a/terra": { message: limitFor("codex-a").message, after: 1 } },
	});
	assertReached(run, [
		["codex-a", "terra", "high"],
		["codex-a", "terra", "high"],
		["codex-b", "terra", "high"],
		["codex-b", "terra", "high"],
	]);
	assert.deepEqual(Object.keys(run.accounts), ["codex-a"]);
});

test("a Chain whose seat group follows another entry takes turns between the seats, too", () => {
	const workspace = makeWorkspace({
		chainsFile: JSON.stringify({
			work: [{ model: "claude-bridge/opus", thinking: "medium" }, seatsEntry("terra", SEATS)],
		}),
		accounts: { "claude-bridge": new Date(Date.now() + 3_600_000).toISOString() },
	});
	try {
		const first = runPiIn(workspace, ["-p", "--model", "chain/work", "say hello"]);
		const second = runPiIn(workspace, ["-p", "--model", "chain/work", "say hello"]);
		assertReached(first, [["codex-a", "terra", "high"]]);
		assertReached(second, [["codex-b", "terra", "high"]]);
	} finally {
		rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("a session on chain/work runs on the work Chain's first entry, at that entry's thinking level", () => {
	const run = runPi(["-p", "--model", "chain/work", "say hello", "say goodbye"]);
	assertReached(run, [
		["test", "alpha", "high"],
		["test", "alpha", "high"],
	]);
});

test("every role in the Chains file is a selectable model under chain/", () => {
	const run = runPi(["--list-models", "chain"]);
	assert.deepEqual(listedRoles(run.stdout).sort(), Object.keys(chains).sort());
});

test("the session records the physical model that answered each request", () => {
	const run = runPi(["-p", "--model", "chain/work", "say hello"]);
	const selection = run.session.find((entry) => entry.type === "model_change");
	assert.deepEqual({ provider: selection?.provider, modelId: selection?.modelId }, { provider: "chain", modelId: "work" });
	const answered = run.session.filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
	assert.equal(answered.length, 1);
	assert.deepEqual(
		{
			provider: answered[0].message?.provider,
			model: answered[0].message?.model,
			thinkingLevel: answered[0].message?.thinkingLevel,
		},
		{ provider: "test", model: "alpha", thinkingLevel: "high" },
	);
});

test("a broken Chains file does not stop a session that is not on a Chain", () => {
	for (const broken of ["{ not json", '{"work": "not a Chain"}', '{"work": [{"model": "test/", "thinking": "high"}]}']) {
		const run = runPi(["-p", "--model", "test/alpha", "say hello"], { chainsFile: broken });
		assert.deepEqual(run.requests.map((request) => request.model), ["alpha"], broken);
		assert.match(run.stderr, /chains:/, `a broken Chains file is not reported: ${broken}`);
	}
});

test("a malformed role is reported with the cause it has: not a list, or an entry in the wrong shape", () => {
	const notAList = runPi(["-p", "--model", "test/alpha", "say hello"], { chainsFile: '{"work": "not a Chain"}' });
	assert.match(notAList.stderr, /chains: .*"work" is not a non-empty list; a Chain is a list of/);
	const badEntry = runPi(["-p", "--model", "test/alpha", "say hello"], {
		chainsFile: '{"work": [{"model": "test/alpha", "thinking": "turbo"}]}',
	});
	assert.match(badEntry.stderr, /chains: .*entry 1 of "work" is not \{model: "provider\/model", thinking: one of/);
	// A group is at least two seats, and names its model without a provider.
	for (const badSeats of [
		'{"model": "terra", "thinking": "high", "seats": ["codex-a"]}',
		'{"model": "codex-a/terra", "thinking": "high", "seats": ["codex-a", "codex-b"]}',
	]) {
		const run = runPi(["-p", "--model", "test/alpha", "say hello"], { chainsFile: `{"work": [${badSeats}]}` });
		assert.match(run.stderr, /chains: .*entry 1 of "work" is not/, badSeats);
	}
});

test("a Chain entry naming a model this Mac does not have is reported, and no request is sent", () => {
	const run = runPi(["-p", "--model", "chain/work", "say hello"], {
		chainsFile: JSON.stringify({ work: [{ model: "test/nope", thinking: "high" }] }),
		expectFailure: true,
	});
	assert.deepEqual(run.requests, []);
	assert.match(run.stderr, /chains: .*chains\.json gives "work" the model test\/nope, which this Mac does not have/);
});

test("a session that loads the extension from its agent folder's extensions/ folder, as an AI node of a Run does, runs on chain/work", () => {
	const run = runPi(["-p", "--model", "chain/work", "say hello"], { fromPiFolder: true });
	assertReached(run, [["test", "alpha", "high"]]);
});

for (const limit of recordedLimits) {
	test(`a used-up account carries the session on to the next entry of its Chain: ${limit.id}`, () => {
		const run = runPi(["-p", "--model", "chain/work", "say hello", "say goodbye"], {
			chainsFile: JSON.stringify({ work: chainFor(limit) }),
			failures: { [`${limit.account}/${limit.model}`]: limit.message },
		});
		assertReached(run, [
			[limit.account, limit.model, "high"],
			[limit.fallback.account, limit.fallback.model, "max"],
			// The next turn stays on the entry that answered last while its account has usage.
			[limit.fallback.account, limit.fallback.model, "max"],
		]);
		assert.match(run.stdout, new RegExp(`answered by ${limit.fallback.model}`));
		assert.deepEqual(Object.keys(run.accounts), [limit.account]);
		assertReset(run.accounts[limit.account], limit.reset);
		const assistant = run.session.filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
		assert.deepEqual(
			assistant.map((entry) => [entry.message?.provider, entry.message?.model, entry.message?.stopReason]),
			[
				[limit.account, limit.model, "error"],
				[limit.fallback.account, limit.fallback.model, "stop"],
				[limit.fallback.account, limit.fallback.model, "stop"],
			],
		);
		const recorded = run.session.filter((entry) => entry.type === "custom_message");
		assert.equal(recorded.length, 1);
		assert.match(recorded[0].content ?? "", new RegExp(`${limit.account} .*used up`));
	});
}

test("a used-up account is marked in ~/.local/state/pi-chains/accounts.json when XDG_STATE_HOME is unset", () => {
	const limit = limitFor("codex-a");
	const workspace = makeWorkspace({
		chainsFile: JSON.stringify({ work: chainFor(limit) }),
		failures: { [`${limit.account}/${limit.model}`]: limit.message },
	});
	try {
		runPiIn(workspace, ["-p", "--model", "chain/work", "say hello"]);
		const marks = join(workspace.home, ".local", "state", "pi-chains", "accounts.json");
		assert.deepEqual(Object.keys(readAccounts(marks)), [limit.account]);
	} finally {
		rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("a session marks the account in the state folder XDG_STATE_HOME names", () => {
	const limit = limitFor("codex-a");
	const workspace = makeWorkspace({
		chainsFile: JSON.stringify({ work: chainFor(limit) }),
		failures: { [`${limit.account}/${limit.model}`]: limit.message },
		stateHome: "state",
	});
	try {
		runPiIn(workspace, ["-p", "--model", "chain/work", "say hello"]);
		const marks = join(workspace.dir, "state", "pi-chains", "accounts.json");
		assert.deepEqual(Object.keys(readAccounts(marks)), [limit.account]);
	} finally {
		rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("sessions in different agent folders share the Mac's account marks", () => {
	const limit = limitFor("codex-a");
	const workspace = makeWorkspace({
		chainsFile: JSON.stringify({ work: chainFor(limit) }),
		failures: { [`${limit.account}/${limit.model}`]: limit.message },
	});
	const otherAgentDir = join(workspace.dir, "other-pi-agent");
	try {
		mkdirSync(otherAgentDir, { recursive: true });
		writeFileSync(join(otherAgentDir, "chains.json"), JSON.stringify({ work: chainFor(limit) }));
		const first = runPiIn(workspace, ["-p", "--model", "chain/work", "say hello"]);
		assertReached(first, [
			[limit.account, limit.model, "high"],
			[limit.fallback.account, limit.fallback.model, "max"],
		]);
		const second = runPiIn(workspace, ["-p", "--model", "chain/work", "say hello"], { agentDir: otherAgentDir });
		assertReached(second, [[limit.fallback.account, limit.fallback.model, "max"]]);
	} finally {
		rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("a second session on the Mac skips an account the first session used up, from its first request", () => {
	const limit = limitFor("codex-a");
	const workspace = makeWorkspace({
		chainsFile: JSON.stringify({ work: chainFor(limit) }),
		failures: { [`${limit.account}/${limit.model}`]: limit.message },
	});
	try {
		const first = runPiIn(workspace, ["-p", "--model", "chain/work", "say hello"]);
		assertReached(first, [
			[limit.account, limit.model, "high"],
			[limit.fallback.account, limit.fallback.model, "max"],
		]);
		assert.deepEqual(Object.keys(readAccounts(accountsPath(workspace))), [limit.account]);
		const second = runPiIn(workspace, ["-p", "--model", "chain/work", "say hello"]);
		assertReached(second, [[limit.fallback.account, limit.fallback.model, "max"]]);
	} finally {
		rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("an expired account mark is ignored", () => {
	const limit = limitFor("codex-a");
	const run = runPi(["-p", "--model", "chain/work", "say hello"], {
		chainsFile: JSON.stringify({ work: chainFor(limit) }),
		accounts: { [limit.account]: new Date(Date.now() - 60_000).toISOString() },
	});
	assertReached(run, [[limit.account, limit.model, "high"]]);
});

test("when every account in a Chain is used up, the session stops with an error naming each account and its reset time", () => {
	const first = limitFor("codex-a");
	const second = limitFor("codex-b");
	const run = runPi(["-p", "--model", "chain/work", "say hello"], {
		chainsFile: JSON.stringify({
			work: [
				{ model: `${first.account}/${first.model}`, thinking: "high" },
				{ model: `${second.account}/${second.model}`, thinking: "max" },
			],
		}),
		failures: {
			[`${first.account}/${first.model}`]: first.message,
			[`${second.account}/${second.model}`]: second.message,
		},
		expectFailure: true,
	});
	assertReached(run, [
		[first.account, first.model, "high"],
		[second.account, second.model, "max"],
	]);
	assert.notEqual(run.status, 0);
	assert.match(run.stderr, /chain\/work is used up/);
	for (const limit of [first, second]) {
		assert.match(run.stderr, new RegExp(`${limit.account} resets at \\d{4}-\\d\\d-\\d\\dT`));
		assertReset(run.accounts[limit.account], limit.reset);
	}
	assert.doesNotMatch(run.stdout, /answered by/);
});

test("an error that is not a usage limit keeps pi's normal retry and marks no account", () => {
	const limit = limitFor("codex-a");
	const run = runPi(["-p", "--model", "chain/work", "say hello"], {
		chainsFile: JSON.stringify({ work: chainFor(limit) }),
		failures: { [`${limit.account}/${limit.model}`]: { message: "provider overloaded: the server is busy", times: 1 } },
		settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } },
	});
	assertReached(run, [
		[limit.account, limit.model, "high"],
		[limit.account, limit.model, "high"],
	]);
	assert.match(run.stdout, new RegExp(`answered by ${limit.model}`));
	assert.deepEqual(run.accounts, {});
});

test("a Claude rate-limit warning does not mark the account used up", () => {
	const limit = limitFor("claude-bridge");
	const warnings = [
		"Claude rate limit warning: 98% used (five_hour)",
		"Claude subscription rate limit reached (five_hour) — resets at 7:30:00 PM",
	];
	for (const warning of warnings) {
		const run = runPi(["-p", "--model", "chain/work", "say hello"], {
			chainsFile: JSON.stringify({ work: chainFor(limit) }),
			failures: { [`${limit.account}/${limit.model}`]: warning },
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } },
			expectFailure: true,
		});
		assert.notEqual(run.status, 0, warning);
		// pi retries the warning, and the session stays on the account; it never reaches the fallback.
		assertReached(run, [
			[limit.account, limit.model, "high"],
			[limit.account, limit.model, "high"],
		]);
		assert.deepEqual(run.accounts, {}, warning);
	}
});

test("a used-up account is skipped for every model on it, not only the model that failed", () => {
	const run = runPi(["-p", "--model", "chain/work", "say hello"], {
		chainsFile: JSON.stringify({
			work: [
				{ model: "codex-a/terra", thinking: "high" },
				{ model: "codex-a/luna", thinking: "max" },
				{ model: "codex-b/sol", thinking: "high" },
			],
		}),
		failures: { "codex-a/terra": "Codex error: The usage limit has been reached" },
	});
	assertReached(run, [
		["codex-a", "terra", "high"],
		["codex-b", "sol", "high"],
	]);
	assert.deepEqual(Object.keys(run.accounts), ["codex-a"]);
});
