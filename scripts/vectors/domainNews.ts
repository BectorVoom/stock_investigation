/**
 * Outbound URL safety (crate `research-domain`, module `news`):
 * `classifyIpAddress`, `looksLikeIpLiteral`, `validateFetchUrl`,
 * `canonicalizeArticleUrl`. The URL cases also pin the Rust `url` crate
 * against Node's WHATWG `URL` parser.
 */
import {
	canonicalizeArticleUrl,
	classifyIpAddress,
	looksLikeIpLiteral,
	validateFetchUrl,
} from "@research/domain";
import { seededRandom, type VectorExporter } from "./shared.ts";

const IPS = [
	"8.8.8.8",
	" 1.1.1.1 ",
	"\u{FEFF}1.1.1.1",
	"0.0.0.0",
	"10.1.2.3",
	"100.63.255.255",
	"100.64.0.0",
	"100.127.255.255",
	"100.128.0.0",
	"127.0.0.1",
	"169.254.169.254",
	"172.15.0.1",
	"172.16.0.1",
	"172.31.255.255",
	"172.32.0.1",
	"192.0.0.1",
	"192.0.1.1",
	"192.0.2.1",
	"192.88.99.1",
	"192.168.1.1",
	"198.18.0.1",
	"198.20.0.1",
	"198.51.100.1",
	"203.0.113.9",
	"223.255.255.255",
	"224.0.0.1",
	"255.255.255.255",
	"256.1.1.1",
	"01.1.1.1",
	"0177.0.0.1",
	"0x7f.0.0.1",
	"1.2.3",
	"1.2.3.4.",
	"1.2.3.4.5",
	"",
	" ",
	"::",
	"::1",
	"::ffff:8.8.8.8",
	"::ffff:10.0.0.1",
	"::ffff:0808:0808",
	"64:ff9b::8.8.8.8",
	"64:ff9b::a00:1",
	"64:ff9b:1::1",
	"2002:0808:0808::1",
	"2002:0a00:0001::1",
	"2001:db8::1",
	"2001:0:1::1",
	"2001:200::1",
	"2001:4860:4860::8888",
	"3fff::1",
	"3fff:1000::1",
	"2606:4700:4700::1111",
	"fc00::1",
	"fe80::1",
	"fe80::1%en0",
	"ff02::1",
	"1:2:3:4:5:6:7:8",
	"1:2:3:4:5:6:7::8",
	"1::2::3",
	":::",
	"12345::1",
	"g::1",
	"2001:db8::1.2.3.4",
	"2001:db8:1:2:3:4:1.2.3.4",
	"::1.2.3.256",
	"[::1]",
	"1.2.3.4%:",
	"２.２.２.２",
];

const HOSTS = [
	"example.com",
	"0x7f.1",
	"2130706433",
	"2130706433.",
	"1..2",
	".",
	"1.2.",
	"0X1F",
	"0x",
	"[::1]",
	"a:b",
	"١٢٣",
];

const URLS = [
	"https://news.example.org/a/1",
	"https://News.Example.ORG/Path?Q=1#Frag",
	"https://news.example.org./trailing-dot",
	"https://news.example.org../two-dots",
	"https://a..b.org/",
	"http://news.example.org/",
	"ftp://news.example.org/",
	"https://user@news.example.org/",
	"https://user:pass@news.example.org/",
	"https://:pass@news.example.org/",
	"https://news.example.org:443/",
	"https://news.example.org:8443/",
	"https://news.example.org:0443/",
	"https://127.0.0.1/",
	"https://0x7f.1/",
	"https://2130706433/",
	"https://[::1]/",
	"https://[2606:4700::1111]/",
	"https://localhost/",
	"https://localhost./",
	"https://printer.local/",
	"https://a.home.arpa/",
	"https://intranet/",
	"https://example.test/",
	"https://example.example/",
	"https://abc.onion/",
	"https://bücher.de/",
	"https://xn--bcher-kva.de/",
	"https://ＥＸＡＭＰＬＥ.com/",
	"https://example.com/a b?c d#e f",
	"https://example.com/%7Euser/%2F/",
	"https://example.com/a/./b/../c/",
	"https://example.com\\path\\to",
	"https:\\\\example.com\\x",
	"  https://example.com/space  ",
	"https://exa\tmple.com/a\nb",
	"https://example.com/?",
	"https://example.com/?#",
	"https://example.com/#",
	"https://example.com/?a=1&a=2&b=",
	"https://example.com/?utm_source=x&UTM_Medium=y&fbclid=1&gclid=2&keep=1",
	"https://example.com/?b=2&a=1&a=0&c",
	"https://example.com/?q=a+b&q=a%20a&q=%E2%82%AC&q=%FF",
	"https://example.com/?%F0%9F%98%80=1&%EE%80%80=2&z=3",
	"https://example.com/a//",
	"https://example.com//",
	"https://example.com/a/b/",
	"https://example.com",
	"https:example.com",
	"https:/example.com/x",
	"https:///example.com/x",
	"//example.com/x",
	"example.com/x",
	"",
	"https://",
	"https://exa mple.com/",
	"https://example.com:/x",
	"https://ex%41mple.com/",
	"https://%65xample.com/",
	"https://example.com/\u{0000}",
	"https://日本語.jp/パス?キー=値",
	"https://example.com/?a=%zz",
	`https://example.com/${"a".repeat(2020)}`,
	`https://example.com/${"a".repeat(2028)}`,
	`https://example.com/${"a".repeat(2029)}`,
	`https://example.com/${"😀".repeat(1015)}`,
];

function generatedUrls(): string[] {
	const random = seededRandom(30);
	const pick = <T>(items: readonly T[]): T =>
		items[Math.floor(random() * items.length)] ?? (items[0] as T);
	const schemes = ["https://", "http://", "HTTPS://", "https:", "https:///"];
	const hosts = [
		"news.example.org",
		"NEWS.example.org",
		"a.b.c.d.e.f",
		"x.local",
		"127.0.0.1",
		"[::1]",
		"bücher.de",
		"a..b",
		"example.com.",
		"0x10.1",
		"ex ample.com",
	];
	const ports = ["", "", "", ":443", ":8080", ":"];
	const paths = ["", "/", "/a", "/a/", "/a//", "/%2e%2e/b", "/ü", "/a b", "/a?b", "/./x/../y"];
	const queries = [
		"",
		"?",
		"?a=1",
		"?utm_campaign=x&b=2",
		"?b=2&a=1",
		"?a+b=c+d",
		"?x=%41%42",
		"?k=v&k=u&K=w",
		"?ocid=1&cmpid=2&REF_SRC=3&mc_eid=4",
	];
	const fragments = ["", "#", "#x", "#a b"];
	const urls: string[] = [];
	for (let index = 0; index < 1500; index += 1) {
		urls.push(
			pick(schemes) + pick(hosts) + pick(ports) + pick(paths) + pick(queries) + pick(fragments),
		);
	}
	return urls;
}

function generatedIps(): string[] {
	const random = seededRandom(31);
	const ips: string[] = [];
	for (let index = 0; index < 1500; index += 1) {
		if (random() < 0.5) {
			ips.push(Array.from({ length: 4 }, () => Math.floor(random() * 260)).join("."));
		} else {
			const groups = Array.from({ length: 8 }, () =>
				Math.floor(random() * 0x10000)
					.toString(16)
					.slice(0, 1 + Math.floor(random() * 4)),
			);
			const prefixes = ["", "", "2001", "2002", "64:ff9b", "fe80", "fc00", "3fff", "ff02"];
			const prefix = prefixes[Math.floor(random() * prefixes.length)] ?? "";
			if (prefix !== "") groups[0] = prefix;
			const cut = Math.floor(random() * 9);
			ips.push(
				random() < 0.4
					? `${groups.slice(0, cut).join(":")}::${groups.slice(cut + 1, 8).join(":")}`
					: groups.join(":"),
			);
		}
	}
	return ips;
}

function verdict<T, E>(result: { ok: true; value: T } | { ok: false; error: E }) {
	return result.ok ? { ok: result.value } : { err: result.error };
}

export const domainNewsExporter: VectorExporter = {
	name: "domain-news",
	async build() {
		const ips = [...IPS, ...generatedIps()];
		const urls = [...URLS, ...generatedUrls()];
		return [
			{
				path: "domain-news/ip.json",
				content: {
					classify: ips.map((input) => ({ input, output: classifyIpAddress(input) })),
					looksLikeIpLiteral: [...HOSTS, ...IPS].map((input) => ({
						input,
						output: looksLikeIpLiteral(input),
					})),
				},
			},
			{
				path: "domain-news/url.json",
				content: {
					validateFetchUrl: urls.map((input) => ({
						input,
						output: verdict(validateFetchUrl(input)),
					})),
					canonicalizeArticleUrl: urls.map((input) => ({
						input,
						output: verdict(canonicalizeArticleUrl(input)),
					})),
				},
			},
		];
	},
};
