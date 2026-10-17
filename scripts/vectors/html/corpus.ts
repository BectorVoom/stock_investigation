/**
 * Generated HTML for the html vectors: a hand-written list of tokenizer and
 * parser edge cases (rr-spec-network-tools §5.3) and a seeded tag-soup
 * generator. Every input is a well-formed JavaScript string (a Rust `&str`
 * cannot hold a lone surrogate).
 */
import { seededRandom } from "../shared.ts";

/** Edge cases for the tokenizer, the entity decoder and the parser's tree rules. */
export const TRICKY_HTML: readonly string[] = [
	// text chunking
	"a < b",
	"a <1 b",
	"a <",
	"<",
	"&",
	"a&",
	"x</",
	"x</ ",
	"x</>y",
	"x</a b",
	"x</a",
	"<a/",
	"<a / ",
	"<a/ x",
	"x<scr",
	"x<script",
	"x<div",
	"x<div class",
	'x<div class="a',
	"x<div class=a",
	"x<div class=",
	"<p>a</p",
	// entities
	"a&amp;b",
	"a&ampb",
	"a&ampx;",
	"a&amp",
	"a&AMP;b&AMPb",
	"&notit;",
	"&notin;",
	"&notin",
	"&notinx",
	"&notinva;",
	"a&Afr;b",
	"<ul>a&Afr;b</ul>",
	"<ul><li>x</li>&NotEqualTilde;</ul>",
	"&NotEqualTilde;&fjlig;&bne;",
	"&zzz;&#;&#x;&#xg;&#a",
	"&#65;&#x41;&#X41;&#0065&#x041x",
	"&#0;&#x80;&#x81;&#x9F;&#128;&#159;&#xD800;&#xDFFF;&#x10FFFF;&#x110000;&#99999999999;",
	"&#9999999999999999999999999999999999999;",
	"&#x1F600;&#128512;",
	"&#65",
	"&#x41",
	"&#x",
	"&#",
	"&;",
	"&&amp;",
	"&amp;&amp;&lt;&gt;&quot;&apos;&nbsp;",
	"&copy=2&copy;&copy",
	'<a href="?a=1&copy=2&copyx&copy;&not;&notx&not">t</a>',
	'<a href="&amp">t</a>',
	'<a href="&ampx">t</a>',
	'<a href="&amp;x&lt">t</a>',
	"<a href=&amp;x&#65>t</a>",
	"<a href='&Afr;&#x1F600;&#128;'>t</a>",
	'<a title="&notin">t</a>',
	'<a title="&notin;">t</a>',
	'<a title="&not=">t</a>',
	// raw text, RCDATA, plaintext
	"<script>a<b>c</b>&amp;</script>d",
	"<script>a</scr</script>b",
	"<script>a</script x>b",
	"<script>a</SCRIPT>b",
	"<script>a</script\t>b",
	"<script>a</script/>b",
	"<script>a</scriptx>b</script>c",
	"<script>a<</script>b",
	"<script>\u001c/script>b",
	"<script>a\u001c/script>b</script>c",
	"<script/>x</script>y",
	"<style>p{}</style>x",
	"<style>a</styl",
	"abc<script>def</scr",
	"<xmp><b>x</b></xmp>y",
	"<iframe><p>x</p></iframe>y",
	"<noembed><p>x</p></noembed>y",
	"<noframes><p>x</p></noframes>y",
	"<noemb>x</noemb>",
	"<noframesx>x</noframesx>",
	"<plaintext><p>x</p></plaintext>",
	"<p>a<plaintext/>b</p>",
	"<title>a<b>c</b>&amp;d</title>e",
	"<title>a&notin;b&Afr;</title>",
	"<title>a</&amp;</title>",
	"<title>x</titlex></title>y",
	"<textarea>a<b>&lt;</textarea>c",
	"<texta>x</texta>",
	"<titlex>y</titlex>",
	"<scripts>y</scripts>",
	"<sty>y</sty>",
	"<SCRIPT>x</script>y",
	"<Title>T</TITLE>",
	// comments, CDATA, doctype, PI, bogus comments
	"a<!-- c -->b",
	"a<!--->b",
	"a<!-->b",
	"a<!-- c --!>b",
	"a<!-- c -- >b-->c",
	"a<!-- c ---->b",
	"a<!---- c --->b",
	"a<!--",
	"a<!---",
	"a<!----",
	"a<!-----",
	"a<!-- c",
	"a<!-",
	"a<!",
	"a<!>b",
	"a<!x>b",
	"a<!x",
	"a<!DOCTYPE html>b",
	"a<!doctype",
	"a<!docx>b",
	"a<!doc",
	"a<?php x ?>b",
	"a<?x",
	"a</ x>b",
	"a</1>b",
	"a<![CDATA[x<y]]>b",
	"a<![CDATA[x",
	"a<![CDA",
	"a<![x]>b",
	"<svg><![CDATA[x<y]]></svg>z",
	"<math><![CDATA[q]]></math>",
	// foreign content
	"<svg><style>a<b>c</b></style></svg>d",
	"<svg><script>a<b>c</b></script></svg>",
	"<svg><rect/><circle/>x</svg>y",
	"<svg/>x",
	"<math/>x",
	"<svg><clippath>a</clippath><clipPath>b</clipPath></svg>",
	"<svg><foreignobject><p>x</p><br/></foreignobject><g/></svg>",
	"<svg><foreignObject><title>T</title><script>s</script></foreignObject></svg>",
	"<svg><desc><b/>x</desc><title>t<b/></title></svg>",
	"<math><mi><script>a<b></script></mi><mo/></math>",
	"<math><annotation-xml><p/>x</annotation-xml></math>",
	"<title><b/>x</title>",
	"<foreignObject>x</foreignObject>",
	"<svg><image/></svg><image src=x>y</image>z",
	"<svg><lineargradient></lineargradient></svg></lineargradient>",
	"<svg><p>x</svg>y",
	"<svg><svg><b/></svg><b/>c</svg>",
	"<div><svg><foreignObject></div></foreignObject></svg>",
	// implied closes
	"<p>a<div>b</div>",
	"<p>a<p>b<p>c",
	"<p>a<h1>b</h1>c",
	"<h1>a<h2>b</h2>c</h1>",
	"<li>a<li>b<ul><li>c<li>d</ul>",
	"<dl><dt>a<dd>b<dt>c</dl>",
	"<table><tr><td>a<td>b<tr><td>c<th>d</table>",
	"<table><thead><tr><th>a<tbody><tr><td>b<tfoot><tr><td>c</table>",
	"<a href=x>a<a href=y>b</a>c</a>",
	"<select><option>a<option>b<optgroup>c<option>d</select>",
	"<form><form><p>x</p></form>y</form>z",
	"<form><div><form>x</form></div></form>",
	"<form/><form>y",
	"</p>",
	"a</p>b",
	"<div></p></div>",
	"</br>",
	"a</br>b",
	"</br x>",
	"</img>",
	"<br/>x",
	"<br>x</br>",
	"<body><head>x</head><link><script>y</script></body>",
	"<head><link><body>x",
	"<ruby>a<rt>b<rp>c</ruby>",
	"<input><textarea>a</textarea><button>b",
	"<p><blockquote>q</blockquote></p>",
	"<p><table><tr><td>x</td></tr></table>",
	"<p><hr>x",
	"<div><span><p>a</div>b",
	"<b><i>x</b></i>",
	"<ul><li><ul><li>a</ul></li></ul>",
	// void elements, including those only htmlparser2 treats as void
	"<basefont>x</basefont>y<command>z<frame>w<isindex>v<keygen>u",
	"<area><base><col><embed><hr><img><input><link><meta><param><source><track><wbr>x",
	"<p>a<img>b<br>c</p>",
	"<LINK><META><BR>x",
	// attributes
	'<div class="a" class="b" CLASS="c">x</div>',
	"<div a b=c d='e' f=\"g\" h = i j= k>x</div>",
	'<div __proto__="x" constructor="y" hasOwnProperty="z" 1="n" 0="m">x</div>',
	"<div role=main>x</div>",
	'<div ROLE="  Navigation  ">x</div>',
	'<div aria-hidden=" TRUE ">x</div><p>y</p>',
	'<div data-x="a>b">x</div>',
	"<div x='a\"b'>x</div>",
	"<div x=a'b\"c>x</div>",
	'<div x="">x</div>',
	"<div x=>x</div>",
	"<div =x>y</div>",
	"<div x/y>z</div>",
	"<div/x>y</div>",
	"<div \t\n\f\r x \n=\n y>z</div>",
	// names
	"<DIV>x</DIV>",
	"<Div>x</dIV>",
	"<x-foo>a</x-foo>",
	"<İmg>a</İmg>",
	"<dİv>a</dİv>",
	"<ΣΑΣ>a</σας>",
	"<aé>x</aé>",
	"<p\u0000>x</p\u0000>",
	"<1p>x",
	"< p>x",
	// controls and odd characters
	"a\u0000b\u0001c\u0085d\u009fe f﻿t u v\u000bw\u000cx\ry",
	"<p>　a　</p><p>﻿b﻿</p><p>\u0085c\u0085</p>",
	"<pre>\r\n\u000bx\u000b\n</pre>",
	'😀<p>😀</p><a href="https://x.example/😀">😀</a>',
	"日本語<b>テキスト</b>",
	"",
	// converter boundaries the soup rarely reaches
	"x</a 😀",
	"<a /😀",
	`<h1>Site</h1><p>short</p><h1>Article</h1><p>${"x".repeat(199)}</p>`,
	`<h1>Site</h1><p>short</p><h1>Article</h1><p>${"x".repeat(200)}</p>`,
	`<h1>Site</h1><p>${"y".repeat(250)}</p><h1>Article</h1><h2>Sub</h2><ul><li>${"z".repeat(300)}</li></ul><p>${"x".repeat(150)}</p><p>${"w".repeat(60)}</p>`,
	`<h1>A</h1><p>${"x".repeat(100)}</p><h1>B</h1><p>${"x".repeat(100)}</p><h1>C</h1><p>tail</p>`,
	`<p>lead</p><h1>Only</h1><p>after</p>`,
	`<h1>Only</h1><p>after</p>`,
	'<p><a href="https://o.example/">Skipper news</a> <a href="https://o.example/">skip-to x</a> <a href="https://o.example/">sKiP x</a> <a href="https://o.example/">skip</a></p>',
	`<ul>${"<li>[a](https://)</li>".repeat(5)}</ul>`,
	`<ul>${"<li>[a](https://x)</li>".repeat(5)}</ul>`,
	`<ol>${"<li>[a](http://x y)</li>".repeat(5)}</ol>`,
	`<ul>${'<li><a href="https://m.example/a">a</a></li>'.repeat(4)}<li><a href="https://m.example/b">b</a><ul>${'<li><a href="https://m.example/c">c</a></li>'.repeat(3)}</ul></li></ul>`,
	`<ul>${'<li><a href="https://m.example/a">a</a></li>'.repeat(4)}<li><pre>p\rq</pre></li></ul>`,
	`<ul>${'<li><a href="https://m.example/a">a</a></li>'.repeat(5)}</ul><main><p>m</p></main>`,
	`<div class="nav-wrap x">a</div><section id="Cookie_Banner">b</section><header class="masthead">c</header><ul class="menu"><li>d</li></ul><span class="nav">e</span><article class="sidebar">f</article>`,
	`<p>keep</p><div role="search main">r</div><div role="MAIN">m</div>`,
	'<p><a href="#x">same</a> <a href="?q#x">query</a> <a href="">empty</a> <a href="  #y  ">spaced</a></p>',
];

/** Tag names the generator draws from: everything the converter or htmlparser2 special-cases. */
const TAG_NAMES = [
	"html",
	"head",
	"body",
	"title",
	"p",
	"div",
	"section",
	"article",
	"main",
	"header",
	"hgroup",
	"figure",
	"figcaption",
	"dl",
	"dt",
	"dd",
	"details",
	"summary",
	"address",
	"search",
	"span",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
	"li",
	"blockquote",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"td",
	"th",
	"a",
	"strong",
	"b",
	"em",
	"i",
	"code",
	"pre",
	"br",
	"hr",
	"img",
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"canvas",
	"iframe",
	"object",
	"embed",
	"form",
	"button",
	"select",
	"textarea",
	"nav",
	"footer",
	"aside",
	"input",
	"option",
	"optgroup",
	"datalist",
	"output",
	"rt",
	"rp",
	"math",
	"mi",
	"mo",
	"mtext",
	"foreignObject",
	"foreignobject",
	"desc",
	"clippath",
	"image",
	"link",
	"meta",
	"basefont",
	"command",
	"frame",
	"isindex",
	"keygen",
	"xmp",
	"noembed",
	"noframes",
	"plaintext",
	"area",
	"base",
	"col",
	"param",
	"source",
	"track",
	"wbr",
	"x-foo",
	"fieldset",
	"picture",
	"sub",
	"İmg",
];

const COMMON_TAGS = [
	"p",
	"div",
	"span",
	"a",
	"li",
	"ul",
	"ol",
	"strong",
	"em",
	"h1",
	"h2",
	"table",
	"tr",
	"td",
	"blockquote",
	"pre",
	"code",
	"br",
	"section",
	"article",
	"main",
	"b",
	"i",
	"th",
	"header",
];

const WORDS = [
	"alpha",
	"beta",
	"Skip to content",
	"skip ",
	"1.",
	"-",
	"*",
	"[x]",
	"(y)",
	"|",
	"#",
	"## ",
	"`",
	"> ",
	"---",
	"lorem ipsum dolor sit amet",
	"1,250 units",
	"é",
	"日本",
	"😀",
	"𝔘",
	" ",
	"  ",
	"\t",
	"\n",
	"\r\n",
	"\u000b",
	"\u000c",
	" ",
	"　",
	"﻿",
	"\u0085",
	" ",
	"\u0000",
	"\u001c",
	"<",
	">",
	"&",
	"=",
	'"',
	"'",
	"/",
	"x".repeat(60),
];

const ENTITIES = [
	"&amp;",
	"&amp",
	"&ampx",
	"&lt;",
	"&gt",
	"&quot;",
	"&nbsp;",
	"&nbsp",
	"&copy",
	"&copy=",
	"&not",
	"&notin",
	"&notin;",
	"&Afr;",
	"&NotEqualTilde;",
	"&fjlig;",
	"&zzz;",
	"&#",
	"&#;",
	"&#65;",
	"&#65",
	"&#x41;",
	"&#X41",
	"&#x1F600;",
	"&#128512;",
	"&#0;",
	"&#x80;",
	"&#x81;",
	"&#xD800;",
	"&#x110000;",
	"&#99999999999;",
	"&ldquo;",
	"&rdquo;",
	"&hellip;",
	"&",
];

const ROLES = [
	"navigation",
	"banner",
	"contentinfo",
	"complementary",
	"search",
	"menu",
	"menubar",
	"dialog",
	"alertdialog",
	"main",
	"article",
	" MAIN ",
	"navigation main",
	"presentation",
	"",
];

const CLASS_TOKENS = [
	"nav",
	"sub-nav",
	"sidebar",
	"footer",
	"document",
	"menu_x",
	"nav2",
	"cookie",
	"share-bar",
	"content",
	"post",
	"breadcrumbs",
	"SKIP",
	"x",
];

const HREFS = [
	"https://other.example/x",
	"https://x.example/p",
	"https://x.example/p#frag",
	"#frag",
	"#",
	"../up",
	"/root",
	"//host.example/p",
	"?q=1",
	"",
	" https://other.example/sp ",
	"javascript:steal()",
	"mailto:a@b.example",
	"data:text/html,x",
	"https://[::1",
	"http://a.b/c?d=1&amp;e=2",
	"https://x.example/😀",
	"https://x.example/a b",
	"ftp://x.example/",
	"HTTPS://OTHER.EXAMPLE/UP",
	"https://xn--nxasmq6b.example/",
	"https://ex\tample.org/\n",
	"https://user:pw@x.example:8080/p",
	"http://0x7f.1/",
	"https://example.com:443/",
];

/** The base URLs the soup is converted against (valid, fragment, query, invalid, non-http). */
export const BASE_URLS = [
	"https://news.synthetic-wire.org/articles/2026/grid/",
	"https://x.example/p",
	"https://x.example/p#frag",
	"http://a.b/c?d=1",
	"",
	"not a url",
	"ftp://x.example/y",
	"https://[::1",
];

export const MAX_CHARS = [0, 1, 50, 2000, 20_000];

/** Option draws for generated documents: mostly realistic limits and valid page URLs. */
export const SOUP_MAX_CHARS = [0, 1, 50, 300, 2000, 2000, 20_000, 20_000, 20_000, 20_000];
export const SOUP_BASE_URLS = [...BASE_URLS, ...BASE_URLS.slice(0, 4), ...BASE_URLS.slice(0, 4)];

export class Soup {
	private readonly random: () => number;

	constructor(seed: number) {
		this.random = seededRandom(seed);
	}

	int(below: number): number {
		return Math.floor(this.random() * below);
	}

	chance(probability: number): boolean {
		return this.random() < probability;
	}

	pick<T>(items: readonly T[]): T {
		const item = items[this.int(items.length)];
		if (item === undefined) throw new Error("empty pick");
		return item;
	}

	private caseVariant(name: string): string {
		if (!this.chance(0.15)) return name;
		return Array.from(name, (character) =>
			this.chance(0.5) ? character.toUpperCase() : character,
		).join("");
	}

	private attributeValue(name: string): string {
		switch (name) {
			case "role":
				return this.pick(ROLES);
			case "class":
			case "id":
				return Array.from({ length: 1 + this.int(3) }, () => this.pick(CLASS_TOKENS)).join(
					this.pick([" ", "-", "_", "  "]),
				);
			case "aria-hidden":
				return this.pick(["true", " TRUE ", "false", ""]);
			case "href":
				return this.pick(HREFS);
			default:
				return this.text(3);
		}
	}

	private attributes(): string {
		let out = "";
		const count = 1 + this.int(3);
		for (let index = 0; index < count; index += 1) {
			const name = this.caseVariant(
				this.pick([
					"role",
					"class",
					"id",
					"aria-hidden",
					"hidden",
					"href",
					"title",
					"__proto__",
					"data-x",
				]),
			);
			const value = this.attributeValue(name.toLowerCase()).replaceAll('"', "&quot;");
			switch (this.int(5)) {
				case 0:
					out += ` ${name}`;
					break;
				case 1:
					out += ` ${name}=${value.replace(/[\s>]/g, "") || "v"}`;
					break;
				case 2:
					out += ` ${name}='${value.replaceAll("'", "")}'`;
					break;
				default:
					out += ` ${name}="${value}"`;
			}
		}
		return out;
	}

	text(words: number): string {
		let out = "";
		const count = 1 + this.int(words);
		for (let index = 0; index < count; index += 1) {
			out += this.chance(0.2) ? this.pick(ENTITIES) : this.pick(WORDS);
			if (this.chance(0.6)) out += " ";
		}
		return out;
	}

	private oddity(): string {
		return this.pick([
			"<!-- c -->",
			"<!-->",
			"<!--->",
			"<!-- c --!>",
			"<!x>",
			"<?php x ?>",
			"</ x>",
			"<![CDATA[c]]>",
			"<!DOCTYPE html>",
			"</br>",
			"</p>",
			"< b",
			"<1",
			"</x-foo>",
			"<script>s<b>x</b></scr",
			"<title>t&amp;</title>",
			"<textarea>a</textarea>",
			"<xmp><i>x</i></xmp>",
			"<svg><b/><style>s<i>t</i></style><foreignObject><p/>q</foreignObject></svg>",
			"<math><mi><b/></mi></math>",
			"<script>\u001c/script>",
			"<style>a</STYLE >",
		]);
	}

	private children(depth: number, budget: { left: number }, most: number): string {
		let out = "";
		const count = this.int(most);
		for (let index = 0; index < count; index += 1) out += this.node(depth + 1, budget);
		return out;
	}

	/** Lists, tables and links with the structure the converter renders. */
	private structure(depth: number, budget: { left: number }): string {
		switch (this.int(5)) {
			case 0: {
				const tag = this.pick(["ul", "ol"]);
				let items = "";
				// A third are link-only lists: menus (rule 4) from five items on.
				const menu = this.chance(0.33);
				const count = menu ? 3 + this.int(6) : 1 + this.int(7);
				for (let index = 0; index < count; index += 1) {
					const body =
						menu || this.chance(0.5)
							? `<a href="${this.pick(HREFS)}">${this.text(2)}</a>`
							: this.children(depth, budget, 3) || this.text(3);
					items += `<li>${body}${this.chance(0.85) ? "</li>" : ""}`;
				}
				return `<${tag}${this.chance(0.2) ? this.attributes() : ""}>${items}</${tag}>`;
			}
			case 1: {
				let rows = "";
				const width = 1 + this.int(4);
				const count = 1 + this.int(4);
				for (let row = 0; row < count; row += 1) {
					let cells = "";
					for (let cell = 0; cell < width; cell += 1) {
						const tag = row === 0 && this.chance(0.6) ? "th" : "td";
						const body = this.chance(0.7) ? this.text(3) : this.children(depth, budget, 2);
						cells += `<${tag}>${body}${this.chance(0.9) ? `</${tag}>` : ""}`;
					}
					rows += `<tr>${cells}${this.chance(0.9) ? "</tr>" : ""}`;
				}
				const wrapped = this.chance(0.3) ? `<tbody>${rows}</tbody>` : rows;
				return `<table>${wrapped}</table>`;
			}
			case 2:
				return `<a href="${this.pick(HREFS)}">${this.text(3)}${this.children(depth, budget, 2)}</a>`;
			case 3: {
				const tag = this.pick(["blockquote", "h1", "h2", "h3", "p", "pre", "dl"]);
				return `<${tag}>${this.text(4)}${this.children(depth, budget, 3)}</${tag}>`;
			}
			default:
				return `<p>${this.text(6)} <${this.pick(["strong", "em", "code", "b", "i"])}>${this.text(2)}</${this.pick(["strong", "em", "code", "b", "i"])}> ${this.text(4)}</p>`;
		}
	}

	/** One node: an element with children, text, or an oddity, within a size budget. */
	node(depth: number, budget: { left: number }): string {
		budget.left -= 1;
		const roll = this.random();
		if (budget.left <= 0 || depth > 45 || roll < 0.3) return this.text(5);
		if (roll < 0.34) return this.oddity();
		if (roll < 0.55) return this.structure(depth, budget);
		const name = this.caseVariant(this.chance(0.7) ? this.pick(COMMON_TAGS) : this.pick(TAG_NAMES));
		const selfClose = this.chance(0.05) ? "/" : "";
		const open = `<${name}${this.chance(0.4) ? this.attributes() : ""}${selfClose}>`;
		const children = this.children(depth, budget, depth < 3 ? 6 : 4);
		const close = this.random();
		if (close < 0.12) return `${open}${children}`;
		if (close < 0.18) return `${open}${children}</${this.pick(TAG_NAMES)}>`;
		if (close < 0.21) return `${open}${children}</${name}x>`;
		return `${open}${children}</${this.caseVariant(name)}>`;
	}

	/** A document of at most roughly `size` nodes, sometimes wrapped in html/body. */
	document(size: number): string {
		const budget = { left: size };
		let body = "";
		while (budget.left > 0) body += this.node(0, budget);
		const main = this.chance(0.25)
			? `<p>${this.text(3)}</p><${this.pick(["main", "article"])}>${body}</main>`
			: body;
		if (this.chance(0.3)) {
			return `<html><head><title>${this.text(4)}</title></head><body>${main}</body></html>`;
		}
		return main;
	}

	/** Random bytes decoded like the fetcher does (`TextDecoder`, replacement characters). */
	noise(length: number): string {
		const bytes = new Uint8Array(length);
		for (let index = 0; index < length; index += 1) {
			bytes[index] = this.chance(0.3)
				? this.pick([0x3c, 0x3e, 0x26, 0x2f, 0x3b, 0x23, 0x21])
				: this.int(256);
		}
		return new TextDecoder("utf-8").decode(bytes);
	}
}
