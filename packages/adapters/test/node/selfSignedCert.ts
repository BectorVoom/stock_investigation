/**
 * Generates a throw-away self-signed TLS certificate in memory, so the tests
 * can run the production pinned-HTTPS code against a local server without any
 * key material in the repository and without shelling out to openssl.
 *
 * Minimal DER encoder for exactly one certificate shape: X.509 v3, ECDSA P-256
 * with SHA-256, subject = issuer = CN, with subjectAltName DNS names and
 * basicConstraints CA:TRUE (so the certificate can be its own trust anchor).
 */
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";

function derLength(length: number): Buffer {
	if (length < 0x80) return Buffer.from([length]);
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: readonly Buffer[]): Buffer {
	const body = Buffer.concat(content);
	return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...items: readonly Buffer[]): Buffer => tlv(0x30, ...items);
const set = (...items: readonly Buffer[]): Buffer => tlv(0x31, ...items);
const oid = (...bytes: readonly number[]): Buffer => tlv(0x06, Buffer.from(bytes));
const octetString = (content: Buffer): Buffer => tlv(0x04, content);
const bitString = (content: Buffer): Buffer => tlv(0x03, Buffer.from([0x00]), content);
const utf8String = (text: string): Buffer => tlv(0x0c, Buffer.from(text, "utf8"));
const booleanTrue = tlv(0x01, Buffer.from([0xff]));

function positiveInteger(bytes: Buffer): Buffer {
	const magnitude = (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0x00]), bytes]) : bytes;
	return tlv(0x02, magnitude);
}

function utcTime(date: Date): Buffer {
	const iso = date.toISOString(); // 2026-10-11T12:34:56.000Z
	const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
	return tlv(0x17, Buffer.from(text, "ascii"));
}

const OID_ECDSA_WITH_SHA256 = oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
const OID_COMMON_NAME = oid(0x55, 0x04, 0x03);
const OID_SUBJECT_ALT_NAME = oid(0x55, 0x1d, 0x11);
const OID_BASIC_CONSTRAINTS = oid(0x55, 0x1d, 0x13);

function toPem(label: string, der: Buffer): string {
	const base64 = der
		.toString("base64")
		.replace(/(.{64})/g, "$1\n")
		.trimEnd();
	return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

export interface TestCertificate {
	readonly certPem: string;
	readonly keyPem: string;
}

export function createSelfSignedCertificate(dnsNames: readonly string[]): TestCertificate {
	const [commonName] = dnsNames;
	if (commonName === undefined) throw new Error("at least one DNS name is required");
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const signatureAlgorithm = sequence(OID_ECDSA_WITH_SHA256);
	const name = sequence(set(sequence(OID_COMMON_NAME, utf8String(commonName))));
	const now = Date.now();
	const serial = randomBytes(8);
	serial[0] = (serial[0] ?? 0) & 0x7f || 0x01;
	const extensions = sequence(
		sequence(
			OID_SUBJECT_ALT_NAME,
			octetString(sequence(...dnsNames.map((dns) => tlv(0x82, Buffer.from(dns, "ascii"))))),
		),
		sequence(OID_BASIC_CONSTRAINTS, booleanTrue, octetString(sequence(booleanTrue))),
	);
	const tbsCertificate = sequence(
		tlv(0xa0, tlv(0x02, Buffer.from([0x02]))), // version 3
		positiveInteger(serial),
		signatureAlgorithm,
		name,
		sequence(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 3_600_000))),
		name,
		publicKey.export({ type: "spki", format: "der" }),
		tlv(0xa3, extensions),
	);
	const certificate = sequence(
		tbsCertificate,
		signatureAlgorithm,
		bitString(sign("sha256", tbsCertificate, privateKey)),
	);
	const certPem = toPem("CERTIFICATE", certificate);
	// Parsing it back fails loudly here rather than as an opaque TLS error in a test.
	new X509Certificate(certPem);
	return { certPem, keyPem: privateKey.export({ type: "sec1", format: "pem" }).toString() };
}
