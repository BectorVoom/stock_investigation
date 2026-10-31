/**
 * The runner shell (crate `research-runner`): the configuration loader of
 * `apps/runner/src/config.ts` run over the inputs of its unit tests plus a
 * seeded corpus of environments, and Node's own dotenv parser
 * (`util.parseEnv`, the code behind `--env-file-if-exists`) run over a
 * corpus of env-file texts.
 *
 * The env-file parser is compared as a map (JavaScript objects order integer
 * keys first, which the Rust side does not reproduce and nothing depends on).
 */
import { parseEnv } from "node:util";
import { loadConfig } from "../../apps/runner/src/config.ts";
import { seededRandom, type VectorExporter } from "./shared.ts";

type Random = () => number;

const pick = <T>(random: Random, items: readonly T[]): T => {
	const item = items[Math.floor(random() * items.length)];
	if (item === undefined) throw new Error("pick from an empty list");
	return item;
};

const TOKEN = "token_with_enough_characters_01";
const BASE: Readonly<Record<string, string>> = {
	RESEARCH_API_URL: "https://research.example.test",
	RUNNER_TOKEN: TOKEN,
};

/** The environments of `apps/runner/test/config.test.ts` and the spec's table. */
const FIXED_ENVIRONMENTS: readonly Readonly<Record<string, string>>[] = [
	{},
	{ RESEARCH_API_URL: "notaurl" },
	{ RESEARCH_API_URL: "http://example.test/api" },
	{ RESEARCH_API_URL: "https://research.example.test", RUNNER_TOKEN: "short" },
	{
		RESEARCH_API_URL: "https://research.example.test",
		RUNNER_TOKEN: "token_with_a_line_break\ninjected",
	},
	BASE,
	{ ...BASE, FINNHUB_API_KEY: "finnhub-key" },
	...[
		"tvly-dev-0123456789",
		" tvly-padded ",
		"short",
		"has space key",
		"tvly-é-key",
		"x".repeat(280),
		"x".repeat(281),
		"",
	].map((value) => ({ ...BASE, TAVILY_API_KEY: value })),
	{ ...BASE, TAVILY_API_KEY: "has space", SEC_USER_AGENT: "short" },
	{
		...BASE,
		FRED_API_KEY: "fred-key",
		TWELVE_DATA_API_KEY: "twelve-key",
		TWELVE_DATA_REQUESTS_PER_MINUTE: "30",
	},
	...["0", "601", "1000", "8.5", "many", "", " 12 ", "007", "٣", "+5", "1e2", "600", "1"].map(
		(value) => ({ ...BASE, TWELVE_DATA_REQUESTS_PER_MINUTE: value }),
	),
	...[
		"0",
		"800",
		"",
		" 5000 ",
		"1000000",
		"1000001",
		"12345678",
		"-1",
		"8.5",
		"many",
		"٣",
		"+5",
		"1e3",
		"0800",
	].map((value) => ({ ...BASE, TWELVE_DATA_DAILY_LIMIT: value })),
	{ ...BASE, TWELVE_DATA_REQUESTS_PER_MINUTE: "0", TWELVE_DATA_DAILY_LIMIT: "x" },
	{
		...BASE,
		GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
		GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
		GOOGLE_TOKEN_FILE: "data/google-token.json",
	},
	{ ...BASE, GOOGLE_TOKEN_FILE: "   " },
	{ ...BASE, GOOGLE_TOKEN_FILE: " \tdata/g.json " },
	{ ...BASE, ALLOW_UNVERIFIED_TOOL_ISOLATION: "1" },
	{ ...BASE, ALLOW_UNVERIFIED_TOOL_ISOLATION: " 1" },
	{ ...BASE, ALLOW_UNVERIFIED_TOOL_ISOLATION: "true" },
	{ ...BASE, SEC_USER_AGENT: "short" },
	{ ...BASE, SEC_USER_AGENT: "Research owner@example.org" },
	{ ...BASE, SEC_USER_AGENT: "x".repeat(200) },
	{ ...BASE, SEC_USER_AGENT: "x".repeat(201) },
	{ ...BASE, SEC_USER_AGENT: "😀".repeat(100) },
	{ ...BASE, SEC_USER_AGENT: "😀".repeat(101) },
	{ ...BASE, SEC_USER_AGENT: "😀".repeat(4) },
	{ ...BASE, SEC_USER_AGENT: "é".repeat(7) },
	{ ...BASE, SEC_USER_AGENT: "﻿   a@example.org   " },
	{ ...BASE, CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "secret" },
	{ ...BASE, CF_ACCESS_CLIENT_ID: "id" },
	{ ...BASE, CF_ACCESS_CLIENT_ID: "  " },
	{ ...BASE, RUNNER_SCRATCH_ROOT: " /tmp/scratch ", RUNNER_PAGES_DIR: "\n" },
	{ ...BASE, RUNNER_TOKEN: `﻿${TOKEN} ` },
	{ ...BASE, RUNNER_TOKEN: `${TOKEN}\n` },
	{ ...BASE, RUNNER_TOKEN: "t".repeat(20) },
	{ ...BASE, RUNNER_TOKEN: "t".repeat(200) },
	{ ...BASE, RUNNER_TOKEN: "t".repeat(201) },
	{ ...BASE, RUNNER_TOKEN: "t".repeat(19) },
	{ ...BASE, RUNNER_TOKEN: `${"t".repeat(19)}é` },
	{ ...BASE, RUNNER_TOKEN: `${"t".repeat(19)}-` },
];

const URL_POOL: readonly string[] = [
	"https://research.example.test",
	"https://research.example.test/",
	"https://research.example.test/base/path",
	"HTTPS://Research.Example.TEST",
	"http://localhost:8788",
	"http://LOCALHOST",
	"http://localhost.",
	"http://127.0.0.1:8788",
	"http://127.1",
	"http://127.0.0.2",
	"http://2130706433",
	"http://0x7f.0.0.1",
	"http://[::1]:8788",
	"http://[0:0:0:0:0:0:0:1]",
	"http://[::2]",
	"http://[::ffff:127.0.0.1]",
	"http://example.test",
	"http://user:pass@localhost",
	"ftp://localhost",
	"ws://localhost",
	"file:///tmp/x",
	"localhost:8788",
	"//localhost",
	"https://",
	"https://exa mple.test",
	"https://münchen.example",
	"https://xn--mnchen-3ya.example",
	"https://example.test:99999",
	"https://example.test:443",
	"  https://research.example.test  ",
	"\thttp://localhost\n",
	"﻿https://research.example.test",
	"http:localhost",
	"http:/localhost",
	"http:\\\\localhost",
	"https://research.example.test?x=1#y",
	"",
	"   ",
	"notaurl",
	"data:text/plain,hi",
	"javascript:alert(1)",
	"HtTp://[::1]",
	"http://localhost:0",
	"http://localhost:65536",
	"https://[::1]",
	"https://127.0.0.1",
	"http://0.0.0.0",
	"http://localhost%2e",
	"http://%6cocalhost",
	"http://local­host",
	"http://ｌｏｃａｌｈｏｓｔ",
];

const TOKEN_POOL: readonly string[] = [
	TOKEN,
	"short",
	"",
	"  ",
	`  ${TOKEN}  `,
	"a".repeat(19),
	"a".repeat(20),
	"A_9".repeat(10),
	"a".repeat(200),
	"a".repeat(201),
	"token with space inside it",
	"token-with-dash-in-the-middle-here",
	"token_with_a_line_break\ninjected",
	`${TOKEN}\r\n`,
	"ｔｏｋｅｎ_ｗｉｔｈ_ｆｕｌｌｗｉｄｔｈ_ｃｈａｒｓ",
	"tökën_with_enough_characters_01",
	"٠".repeat(25),
];

const PLAIN_POOL: readonly string[] = [
	"",
	" ",
	"value",
	"  padded value  ",
	"\t",
	" nbsp ",
	"﻿bom",
	"line\nbreak",
	"ünï",
	"😀",
	"a".repeat(7),
	"a".repeat(8),
	"a".repeat(200),
	"a".repeat(201),
	"é".repeat(8),
	"é".repeat(200),
	"é".repeat(201),
	"😀".repeat(8),
	"😀".repeat(200),
	"😀".repeat(201),
	"  sep  ",
	"\u0085nel\u0085",
];

const RATE_POOL: readonly string[] = [
	"",
	" ",
	"0",
	"1",
	"8",
	"600",
	"601",
	"999",
	"1000",
	"01",
	"001",
	"0001",
	"-1",
	"+1",
	"1.0",
	"1e1",
	"0x10",
	" 30 ",
	"٣",
	"３０",
	"NaN",
	"Infinity",
	"12abc",
	"\n7\n",
];

const FLAG_POOL: readonly string[] = ["1", "0", "true", "", " 1", "1 ", "01", "yes"];

const OPTIONAL_KEYS = [
	"CF_ACCESS_CLIENT_ID",
	"CF_ACCESS_CLIENT_SECRET",
	"SEC_USER_AGENT",
	"RUNNER_SCRATCH_ROOT",
	"RUNNER_PAGES_DIR",
	"FRED_API_KEY",
	"TWELVE_DATA_API_KEY",
	"FINNHUB_API_KEY",
	"GOOGLE_OAUTH_CLIENT_ID",
	"GOOGLE_OAUTH_CLIENT_SECRET",
	"GOOGLE_TOKEN_FILE",
] as const;

const DAILY_LIMIT_POOL: readonly string[] = ["0", "800", "1", "", " 9 ", "1000000", "1000001", "x"];

function randomEnvironment(random: Random): Record<string, string> {
	const env: Record<string, string> = {};
	// Most environments are valid in the two required fields so the optional
	// ones get exercised too.
	if (random() < 0.9) env.RESEARCH_API_URL = pick(random, URL_POOL);
	if (random() < 0.9) env.RUNNER_TOKEN = pick(random, TOKEN_POOL);
	if (random() < 0.7) {
		env.RESEARCH_API_URL = random() < 0.6 ? (BASE.RESEARCH_API_URL ?? "") : pick(random, URL_POOL);
		env.RUNNER_TOKEN = random() < 0.6 ? TOKEN : pick(random, TOKEN_POOL);
	}
	for (const key of OPTIONAL_KEYS) {
		if (random() < 0.35) env[key] = pick(random, PLAIN_POOL);
	}
	if (random() < 0.4) env.TWELVE_DATA_REQUESTS_PER_MINUTE = pick(random, RATE_POOL);
	if (random() < 0.3) env.TWELVE_DATA_DAILY_LIMIT = pick(random, DAILY_LIMIT_POOL);
	if (random() < 0.3) env.ALLOW_UNVERIFIED_TOOL_ISOLATION = pick(random, FLAG_POOL);
	return env;
}

function configCase(env: Readonly<Record<string, string>>) {
	const result = loadConfig(env);
	return {
		env,
		result: result.ok
			? { ok: true, value: result.value }
			: { ok: false, problems: result.problems },
	};
}

/* ---------- Env files ---------- */

const ENV_FIXED: readonly string[] = [
	"A=1\nB=2",
	"A = 1",
	"export A=1",
	"export  A=1",
	" export A=1",
	'A="x y"',
	"A='x y'",
	"A=`x y`",
	'A="x\\ny"',
	"A='x\\ny'",
	'A="multi\nline"',
	"A='multi\nline'",
	"A=x # c",
	"A=x#c",
	'A="x" # c\nB=2',
	'A="x"junk\nB=2',
	'A="unterminated\nB=2',
	"A='unterminated\nB=2",
	"# c\nA=1",
	"A=1\r\nB=2\r\n",
	"A=\nB=2",
	"A=",
	"=1",
	" =1\nB=2",
	"A",
	"A\nB=1",
	"A=1\nA=2",
	'A=""',
	"A=''",
	"A=  spaced  ",
	"A=\t1\t",
	"\tA=1",
	'A="x\\"y"',
	'A="a" "b"',
	"KEY=va=lue",
	"A=1 # c\n#B=2\nC=3",
	'A="x\\ny" # c',
	"export=1",
	"export A",
	'A="x"\n',
	"A='x'y'",
	'A="unterminated',
	"A='x",
	'A="x\ny\nB=2',
	"A=`a\nb`\nC=1",
	'A="a\\\\nb"',
	"\n\n\nA=1\n\n\n",
	"A=1\n\n\nB=2",
	"a b=1",
	"A B = 1",
	"A=#c",
	"A= #c",
	'A="#c"',
	"export\tA=1",
	"A=éè",
	"﻿A=1",
	"A='x' # c\nB=2",
	"A='x' y\nB=2",
	"A='x'  y=2\nB=3",
	"A='x'\ny=2",
	'A="x" y=2',
	"A='x' y=2",
	"A=x y=2\nB=3",
	"A=x y=2",
	'A="x\ny\nB=2\nC=3',
	'A="x\n\ny\nB=2',
	'A="x\n#y\nB=2',
	"A='x\nz=1",
	"=\nB=2",
	"export A=\nB=2",
	"export =1",
	"A= \nB=2",
	"A=\n",
	"A=\n\n",
	"#only a comment",
	"# c\n# d\n",
	"A=1\n# c\nB=2",
	"A=1 # c\nB=2 # d",
	"A=1 # c\nB=2 # d\n",
	"A=1# c\nB=2",
	"A='x # not a comment'\nB=2",
	'A="it\'s"\nB=\'say "hi"\'',
	'A=`it\'s "x"`',
	'A="x"\nA="y"',
	"A=1\nexport A=2",
	"export A=1\nA=2",
	"RESEARCH_API_URL=https://evil.example\nRUNNER_TOKEN=from_file_0123456789",
	"SEC_USER_AGENT=Research owner@example.org\nFRED_API_KEY=abc123 # my key\n",
	"GOOGLE_TOKEN_FILE=\"/data dir/google-token.json\"\nRUNNER_PAGES_DIR='/p'",
];

const ENV_TOKENS: readonly string[] = [
	"A",
	"B",
	"KEY",
	"export ",
	"export",
	" ",
	"  ",
	"=",
	"=",
	"\n",
	"\n",
	"\r\n",
	"#",
	"'",
	'"',
	"`",
	"\\n",
	"\\",
	"x",
	"1",
	"\t",
	"é",
	"😀",
	"# c",
	" # c",
	"v=w",
];

function randomEnvText(random: Random): string {
	const count = 1 + Math.floor(random() * 14);
	let text = "";
	for (let index = 0; index < count; index += 1) text += pick(random, ENV_TOKENS);
	return text;
}

function envCase(text: string) {
	const parsed = parseEnv(text);
	return {
		text,
		parsed: Object.entries(parsed).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	};
}

export const runnerExporter: VectorExporter = {
	name: "runner",
	async build() {
		const random = seededRandom(0x72756e31);
		const environments: Readonly<Record<string, string>>[] = [...FIXED_ENVIRONMENTS];
		for (const url of URL_POOL) environments.push({ ...BASE, RESEARCH_API_URL: url });
		for (const token of TOKEN_POOL) environments.push({ ...BASE, RUNNER_TOKEN: token });
		for (const value of PLAIN_POOL) {
			for (const key of OPTIONAL_KEYS) environments.push({ ...BASE, [key]: value });
		}
		for (let index = 0; index < 1500; index += 1) environments.push(randomEnvironment(random));

		const texts: string[] = [...ENV_FIXED];
		for (let index = 0; index < 6000; index += 1) texts.push(randomEnvText(random));

		return [
			{ path: "runner/config.json", content: { cases: environments.map(configCase) } },
			{ path: "runner/env_file.json", content: { cases: texts.map(envCase) } },
		];
	},
};
