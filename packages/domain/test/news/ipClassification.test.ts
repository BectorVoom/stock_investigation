import { describe, expect, it } from "vitest";
import { classifyIpAddress, looksLikeIpLiteral } from "../../src/news/ipClassification.ts";

describe("classifyIpAddress: IPv4 (SEC-002)", () => {
	it.each([
		["127.0.0.1", "loopback"],
		["127.255.255.254", "loopback /8 upper end"],
		["10.0.0.1", "RFC1918 10/8"],
		["10.255.255.255", "RFC1918 10/8 upper end"],
		["172.16.0.1", "RFC1918 172.16/12 lower end"],
		["172.31.255.255", "RFC1918 172.16/12 upper end"],
		["192.168.0.1", "RFC1918 192.168/16"],
		["192.168.255.255", "RFC1918 192.168/16 upper end"],
		["169.254.169.254", "link-local cloud metadata"],
		["169.254.0.1", "link-local"],
		["100.64.0.1", "CGNAT lower end"],
		["100.127.255.255", "CGNAT upper end"],
		["0.0.0.0", "unspecified"],
		["0.1.2.3", "this-network 0/8"],
		["192.0.0.1", "IETF protocol assignments"],
		["192.0.2.1", "TEST-NET-1"],
		["192.88.99.1", "6to4 relay anycast"],
		["198.18.0.1", "benchmarking lower end"],
		["198.19.255.255", "benchmarking upper end"],
		["198.51.100.7", "TEST-NET-2"],
		["203.0.113.9", "TEST-NET-3"],
		["224.0.0.1", "multicast"],
		["239.255.255.250", "multicast SSDP"],
		["240.0.0.1", "reserved"],
		["255.255.255.255", "broadcast"],
	])("%s (%s) is non-public", (address) => {
		expect(classifyIpAddress(address)).toBe("non-public");
	});

	it.each([
		"8.8.8.8",
		"1.1.1.1",
		"93.184.216.34",
		"11.0.0.1",
		"126.255.255.255",
		"128.0.0.1",
		"100.63.255.255",
		"100.128.0.1",
		"169.253.255.255",
		"169.255.0.1",
		"172.15.255.255",
		"172.32.0.1",
		"192.167.255.255",
		"192.169.0.1",
		"198.17.255.255",
		"198.20.0.1",
		"223.255.255.255",
	])("%s, just outside every special range, is public", (address) => {
		expect(classifyIpAddress(address)).toBe("public");
	});

	it.each([
		["2130706433", "decimal alias of 127.0.0.1"],
		["0x7f.0.0.1", "hex octet alias of 127.0.0.1"],
		["0x7f000001", "hex integer alias of 127.0.0.1"],
		["0177.0.0.1", "octal octet alias of 127.0.0.1"],
		["017700000001", "octal integer alias of 127.0.0.1"],
		["127.1", "short form of 127.0.0.1"],
		["010.0.0.1", "leading-zero octet"],
		["1.2.3", "three octets"],
		["1.2.3.4.5", "five octets"],
		["256.0.0.1", "octet out of range"],
		["1.2.3.-4", "negative octet"],
		["1.2.3.4/8", "CIDR suffix"],
		["1.2.3.", "empty octet"],
		["a.b.c.d", "letters"],
		["１２７.0.0.1", "full-width digits"],
		["", "empty"],
		["   ", "blank"],
		["example.com", "hostname"],
	])("%s (%s) is invalid, never public", (address) => {
		expect(classifyIpAddress(address)).toBe("invalid");
	});

	it("ignores surrounding whitespace", () => {
		expect(classifyIpAddress(" 8.8.8.8 ")).toBe("public");
		expect(classifyIpAddress("\t127.0.0.1\n")).toBe("non-public");
	});
});

describe("classifyIpAddress: IPv6 (SEC-002)", () => {
	it.each([
		["::", "unspecified"],
		["::1", "loopback"],
		["0:0:0:0:0:0:0:1", "loopback, uncompressed"],
		["0000:0000:0000:0000:0000:0000:0000:0001", "loopback, fully padded"],
		["::ffff:127.0.0.1", "IPv4-mapped loopback, dotted"],
		["::ffff:7f00:1", "IPv4-mapped loopback, hex"],
		["::FFFF:127.0.0.1", "IPv4-mapped loopback, upper case"],
		["0:0:0:0:0:ffff:7f00:1", "IPv4-mapped loopback, uncompressed"],
		["::ffff:10.0.0.1", "IPv4-mapped RFC1918"],
		["::ffff:192.168.1.1", "IPv4-mapped RFC1918"],
		["::ffff:169.254.169.254", "IPv4-mapped cloud metadata"],
		["::ffff:a9fe:a9fe", "IPv4-mapped cloud metadata, hex"],
		["::ffff:100.64.0.1", "IPv4-mapped CGNAT"],
		["::127.0.0.1", "IPv4-compatible loopback"],
		["::10.0.0.1", "IPv4-compatible RFC1918"],
		["64:ff9b::7f00:1", "NAT64 loopback"],
		["64:ff9b::127.0.0.1", "NAT64 loopback, dotted"],
		["64:ff9b::10.0.0.1", "NAT64 RFC1918"],
		["64:ff9b::a9fe:a9fe", "NAT64 cloud metadata"],
		["64:ff9b:1::1", "local-use NAT64"],
		["2002:7f00:1::", "6to4 loopback"],
		["2002:a00:1::1", "6to4 RFC1918 10/8"],
		["2002:c0a8:101::1", "6to4 RFC1918 192.168/16"],
		["2002:a9fe:a9fe::", "6to4 cloud metadata"],
		["fc00::1", "unique local"],
		["fd12:3456:789a::1", "unique local"],
		["fe80::1", "link-local"],
		["fe80::1%eth0", "link-local with zone"],
		["fec0::1", "deprecated site-local"],
		["ff02::1", "multicast"],
		["2001:db8::1", "documentation"],
		["2001::1", "Teredo / IETF protocol assignments"],
		["2001:0:4136:e378:8000:63bf:3fff:fdd2", "Teredo"],
		["100::1", "discard-only"],
		["4000::1", "outside global unicast"],
		["e000::1", "reserved"],
	])("%s (%s) is non-public", (address) => {
		expect(classifyIpAddress(address)).toBe("non-public");
	});

	it.each([
		"2606:4700:4700::1111",
		"2001:4860:4860::8888",
		"2a00:1450:4001:81b::200e",
		"2620:fe::fe",
		"::ffff:8.8.8.8",
		"::ffff:808:808",
		"64:ff9b::8.8.8.8",
		"2002:808:808::1",
	])("%s is public", (address) => {
		expect(classifyIpAddress(address)).toBe("public");
	});

	it.each([
		["[::1]", "bracketed literal"],
		[":::", "three colons"],
		["1::2::3", "two compressions"],
		["12345::1", "group too long"],
		["::g", "non-hex group"],
		["1:2:3:4:5:6:7", "seven groups"],
		["1:2:3:4:5:6:7:8:9", "nine groups"],
		["1:2:3:4:5:6:7::8", "compression with nothing to compress"],
		["::ffff:256.0.0.1", "embedded IPv4 out of range"],
		["::ffff:0x7f.0.0.1", "embedded hex IPv4"],
		["::ffff:0177.0.0.1", "embedded octal IPv4"],
		["::1.2.3", "embedded short IPv4"],
		["1.2.3.4::", "IPv4 in a leading position"],
		["::1 ::1", "two addresses"],
		["%eth0", "zone only"],
	])("%s (%s) is invalid, never public", (address) => {
		expect(classifyIpAddress(address)).toBe("invalid");
	});
});

describe("looksLikeIpLiteral", () => {
	it.each([
		"127.0.0.1",
		"8.8.8.8",
		"2130706433",
		"0x7f.0.0.1",
		"0x7f000001",
		"0X7F000001",
		"0177.0.0.1",
		"127.1",
		"1.2.3.4.",
		"[::1]",
		"::1",
		"[::ffff:7f00:1]",
		"fe80::1",
		"123",
	])("treats %s as an IP literal", (hostname) => {
		expect(looksLikeIpLiteral(hostname)).toBe(true);
	});

	it.each([
		"example.com",
		"news.example.co.jp",
		"1example.com",
		"example1.com",
		"0xdeadbeef.com",
		"deadbeef",
		"10.example",
		"a.1",
	])("does not treat %s as an IP literal", (hostname) => {
		expect(looksLikeIpLiteral(hostname)).toBe(false);
	});
});
