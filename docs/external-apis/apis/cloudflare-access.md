# External API: Cloudflare Access signing keys

## 1. Overview

| Property | Value |
|---|---|
| Provider | Cloudflare (Cloudflare Zero Trust, Access) |
| Purpose | The API Worker, when deployed behind Cloudflare Access (`AUTH_MODE=cloudflare-access`, ADR-0002), verifies the `Cf-Access-Jwt-Assertion` JWT of every request itself. It fetches the Access team's public signing keys (a JSON Web Key Set) to check the token's RS256 signature. Local use (`bun run dev`, `bun run prod`) runs with `AUTH_MODE=local-dev` and never calls this endpoint. |
| Hosts | `<team-name>.cloudflareaccess.com` — computed from `ACCESS_TEAM_DOMAIN` (the deployment in `infra/wrangler.jsonc` uses the owner's team domain). |
| Endpoints | `GET /cdn-cgi/access/certs` — the team's current and previous signing keys |
| Authentication | None. The key set is public. |
| Configuration | `AUTH_MODE=cloudflare-access`, `ACCESS_TEAM_DOMAIN` (host), `ACCESS_AUDIENCE` (the Access application's AUD tag), `OWNER_EMAIL`; Worker variables in `infra/wrangler.jsonc` (`env.production.vars`). With any of them empty every request is denied without a call. |
| Usage Limits | No published quota. Cloudflare answers `Cache-Control: public, max-age=14400`; our code does not use that header but caches the key set itself for 10 minutes per isolate (below). |
| Called By | API Worker (`apps/api`), on the first authenticated request of an isolate and whenever its cached key set is older than 10 minutes. Not the runner, not the browser. |
| Code | `apps/api/src/auth.ts`, `apps/api/src/http.ts`, `apps/api/src/env.ts`, `apps/api/test/joseForDocExamples.ts` |
| Official Documentation | [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/), [Application token](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/), [jose `createRemoteJWKSet`](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md) |
| Last Verified | 2026-10-31, live responses, request from the `jose` source (section 7) |

`createAccessAuthenticator` builds one `jose` remote key set per configuration (kept for the life of the isolate by `ownerAuthenticatorFor`) for `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`. `jose` fetches the set when a token needs verifying and no fresh set is cached, through our `keySetFetch` (`jose`'s `customFetch` option), which sends `jose`'s request unchanged and turns any failure to obtain a valid key set into `AUTH_KEYS_UNAVAILABLE` with the endpoint's status; then `jwtVerify` checks the signature (`RS256` only), the issuer `https://<ACCESS_TEAM_DOMAIN>` and the audience `ACCESS_AUDIENCE`; the payload's `email` must be `OWNER_EMAIL`.

## 2. Input Parameters

### GET /cdn-cgi/access/certs

The request is built by `jose` 6.2.12 (`createRemoteJWKSet` with default options).

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `<team-name>.cloudflareaccess.com` | host | string | Yes | none; we send `ACCESS_TEAM_DOMAIN` | the team domain shown in Zero Trust → Settings → Custom pages | Which Access organisation's keys to return. |
| `accept` | header | string | No | provider: any; we send `application/json, application/jwk-set+json` | — | Set by `jose` when absent. |
| `User-Agent` | header | string | No | we send `jose/v6.2.12` | — | Set by `jose` unless the runtime's `navigator.userAgent` starts with `Mozilla/5.0` (in Workers it is `Cloudflare-Workers`, so it is sent). |

No query parameters and no body. Redirects are not followed (`redirect: "manual"`).

## 3. Output Parameters

### GET /cdn-cgi/access/certs

`application/json; charset=utf-8`; a JSON Web Key Set (RFC 7517) with two Cloudflare extensions.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.keys` | array of object | No | No | Yes | The signing keys: the current one and the previous one during a rotation. `jose` requires an array. |
| `$.keys[].kid` | string | No | No | Yes | Key id (hex SHA-256); matched against the JWT header's `kid`. |
| `$.keys[].kty` | string | No | No | Yes | `RSA`. |
| `$.keys[].alg` | string | No | No | Yes | `RS256`; `jose` uses only keys compatible with the token's `alg`, and we accept only `RS256`. |
| `$.keys[].use` | string | No | No | Yes | `sig`; a key whose `use` is not `sig` is skipped. |
| `$.keys[].e` | string | No | No | Yes | RSA public exponent, base64url (`AQAB`). |
| `$.keys[].n` | string | No | No | Yes | RSA modulus, base64url. |
| `$.public_cert` | object | No | No | No | The current key as an X.509 certificate: `kid` and PEM `cert`. |
| `$.public_cert.kid` | string | No | No | No | Same id as the matching `keys[]` entry. |
| `$.public_cert.cert` | string | No | No | No | PEM certificate, `\n` line breaks. |
| `$.public_certs` | array of object | No | No | No | Every key in `keys` as `{ kid, cert }`. |
| `$.public_certs[].kid` | string | No | No | No | Key id. |
| `$.public_certs[].cert` | string | No | No | No | PEM certificate. |

## 4. Error Handling

### HTTP status codes

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
Any failure to obtain the keys denies the request (fail closed, ARCH-017) but is answered as `AUTH_KEYS_UNAVAILABLE`, not as "sign in": the session may be fine. The endpoint's status is kept unchanged as `upstreamStatus` and, when it is a 4xx/5xx, used as the response status ([error handling §4a](../../rule/error_handling.md)); otherwise the code's own 502 applies. `detail` says which failure it was. Each such answer is logged as `owner_auth_keys_unavailable` (`detail`, `upstreamStatus`, `route`) by `ownerAuthFailure` (`apps/api/src/http.ts`).

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 200 with a key set | Known team domain | Builds the local key set; the token is then verified (a bad token is `UNAUTHENTICATED`). | — |
| 200 with anything else | Not expected (e.g. an HTML page) | The body is read chunk by chunk and must be a key set (`{ "keys": [ {…}, … ] }`); reading stops, and the stream is cancelled, as soon as it passes 1 MiB. No token can be verified. | `AUTH_KEYS_UNAVAILABLE` (502), `detail` `KEY_SET_INVALID`, no `upstreamStatus` |
| 404 | Unknown team domain (HTML page "Unable to find your Access organization!") | No token can be verified. | `AUTH_KEYS_UNAVAILABLE` (404), `detail` `KEY_FETCH_HTTP_ERROR`, `upstreamStatus` 404 |
| other 4xx, 5xx | Outage, misconfiguration | Same as 404. | `AUTH_KEYS_UNAVAILABLE` (status), `detail` `KEY_FETCH_HTTP_ERROR` |
| 3xx | Redirect | Not followed (`redirect: "manual"`); same as 404, but a 3xx is not a response status (§4a). | `AUTH_KEYS_UNAVAILABLE` (502), `upstreamStatus` the 3xx |
| no answer | Network failure, or the headers and the whole body not within 5 s (a stalled body is cancelled) | No token can be verified. | `AUTH_KEYS_UNAVAILABLE` (502), `detail` `KEY_FETCH_FAILED` or `KEY_FETCH_TIMEOUT`, no `upstreamStatus` |

### Provider error codes and body

None: errors are an HTML page with a plain HTTP status; an error body is not read (only a 200's body, as the key set).

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 5 s per fetch, headers and body together (`jose` default `timeoutDuration`; `keySetFetch` also stops reading the body when it passes); body cap 1 MiB. A timeout fails that request as `AUTH_KEYS_UNAVAILABLE` (`KEY_FETCH_TIMEOUT`) with 502, not 504: no answer arrived, so §4a keeps the code's own status, and one code has one status (`STATUS` in `apps/api/src/http.ts`); `detail` tells a timeout from a refused connection. | `apps/api/src/auth.ts` |
| Retries | None within a request. A token whose `kid` is not in the cached set triggers one refetch, at most every 30 s (`cooldownDuration`), which picks up a key rotation. | `apps/api/src/auth.ts` |
| Rate limit | Not applicable: one fetch per isolate per 10 minutes, plus rotation refetches. | — |
| Cache | The parsed key set, per isolate and configuration, for 10 minutes (`cacheMaxAge` default). | `apps/api/src/auth.ts` |
| Fallback | None: without keys no token can be verified, so the API answers `AUTH_KEYS_UNAVAILABLE` to every request until the endpoint answers again (fail closed, ARCH-017); the web shows "Sign-in could not be checked right now … try again" rather than "Sign-in required". | `apps/api/src/auth.ts`, `apps/api/src/http.ts`, `apps/web/src/api/errors.messages.ts` |

## 5. Examples

### GET /cdn-cgi/access/certs

Request:

```http
GET /cdn-cgi/access/certs HTTP/1.1
Host: <team-name>.cloudflareaccess.com
accept: application/json, application/jwk-set+json
User-Agent: jose/v6.2.12
```

Verified: spec, 2026-10-31, the request `jose` 6.2.12 `createRemoteJWKSet` builds (`dist/webapi/jwks/remote.js`: method, `accept`, `User-Agent`, `redirect: "manual"`); not captured on the wire. The same URL answered the response below to `curl`.

Response:

```http
HTTP/2 200
content-type: application/json; charset=utf-8
access-control-allow-origin: *
cache-control: public, max-age=14400, must-revalidate, no-transform
server: cloudflare
```

<!-- example: cloudflare-access-certs -->
```json
{
  "keys": [
    {
      "kid": "3927eca979364ff16db41a2031f635466b5d5f392a25f88f328f86f37db66f08",
      "kty": "RSA",
      "alg": "RS256",
      "use": "sig",
      "e": "AQAB",
      "n": "rlZp3CRJEXocwc9QW8VxT8KJdyzdVG7Y0C8mQkTeo8stL_PoTGslIa5tNdI4ba1YZZJ9sUbPFbem-0Q0unwD_yYelm24pwEZVBfC3rnyuN4b7gfitcSkeZrKlwnvU1iNz9KbsEFC7nGZWShp0zlDc20L8KPCBntYo_hriLooyHtv_skirZ6evrGvNErC-Sn_lUzCKN6lz2sv4VxHMWGS7CBtHxZ_JbMvgOFRj1HAKenfcD0y1TsvgZ8l54eBHlAlzTPOkKcFa4Wg1icPV8QlTidjClA5cmk0gu1aj_cd1R-JGMgInelyvbkZj81CVxCX-1aNc_D7FcjeBFQyA0yw-w"
    }
  ],
  "public_cert": {
    "kid": "3927eca979364ff16db41a2031f635466b5d5f392a25f88f328f86f37db66f08",
    "cert": "-----BEGIN CERTIFICATE-----\nMIIDTTCCAjWgAwIBAgIRAPyAlJauQIcqo82ApOL1JYIwDQYJKoZIhvcNAQELBQAw\nYjELMAkGA1UEBhMCVVMxDjAMBgNVBAgTBVRleGFzMQ8wDQYDVQQHEwZBdXN0aW4x\nEzARBgNVBAoTCkNsb3VkZmxhcmUxHTAbBgNVBAMTFGNsb3VkZmxhcmVhY2Nlc3Mu\nY29tMB4XDTI2MTAxNDIzMjIzMFoXDTI3MTAyODIzMjIzMFowYjELMAkGA1UEBhMC\nVVMxDjAMBgNVBAgTBVRleGFzMQ8wDQYDVQQHEwZBdXN0aW4xEzARBgNVBAoTCkNs\nb3VkZmxhcmUxHTAbBgNVBAMTFGNsb3VkZmxhcmVhY2Nlc3MuY29tMIIBIjANBgkq\nhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArlZp3CRJEXocwc9QW8VxT8KJdyzdVG7Y\n0C8mQkTeo8stL/PoTGslIa5tNdI4ba1YZZJ9sUbPFbem+0Q0unwD/yYelm24pwEZ\nVBfC3rnyuN4b7gfitcSkeZrKlwnvU1iNz9KbsEFC7nGZWShp0zlDc20L8KPCBntY\no/hriLooyHtv/skirZ6evrGvNErC+Sn/lUzCKN6lz2sv4VxHMWGS7CBtHxZ/JbMv\ngOFRj1HAKenfcD0y1TsvgZ8l54eBHlAlzTPOkKcFa4Wg1icPV8QlTidjClA5cmk0\ngu1aj/cd1R+JGMgInelyvbkZj81CVxCX+1aNc/D7FcjeBFQyA0yw+wIDAQABMA0G\nCSqGSIb3DQEBCwUAA4IBAQAZelVRi7YCj2hRxeKNvp1P5n9EQbWAaUIXI5AMDThF\nVilxMrFuh6RZZGuCUjY7kOaVrHg+YEF5jYNAB3X0rNjbmnKFKV1GsW9ypV65x0Kz\naCtCWzeyOKgxcKoYv1bLxlOWTt0H4V4vgDDGXWuOV6e/mczay36tZjt/8AEC95ep\nZEXlJflkQ1oCnKQKyXtzAvIgKm2Y+l0Md/LXkp82EgcQ6GJJRCz9XM4oO3P0w04u\n7SeVB58DFnkETVOTDgTVKeKl3Z7+nirLG8Kjp/KPxHpEwVkciKS/woTT6BhwpfnF\nZY5p9Mi2OMnpGTkrG9dgeTt1wxkyOyUwgO2hguYwXSyq\n-----END CERTIFICATE-----\n"
  },
  "public_certs": [
    {
      "kid": "3927eca979364ff16db41a2031f635466b5d5f392a25f88f328f86f37db66f08",
      "cert": "-----BEGIN CERTIFICATE-----\nMIIDTTCCAjWgAwIBAgIRAPyAlJauQIcqo82ApOL1JYIwDQYJKoZIhvcNAQELBQAw\nYjELMAkGA1UEBhMCVVMxDjAMBgNVBAgTBVRleGFzMQ8wDQYDVQQHEwZBdXN0aW4x\nEzARBgNVBAoTCkNsb3VkZmxhcmUxHTAbBgNVBAMTFGNsb3VkZmxhcmVhY2Nlc3Mu\nY29tMB4XDTI2MTAxNDIzMjIzMFoXDTI3MTAyODIzMjIzMFowYjELMAkGA1UEBhMC\nVVMxDjAMBgNVBAgTBVRleGFzMQ8wDQYDVQQHEwZBdXN0aW4xEzARBgNVBAoTCkNs\nb3VkZmxhcmUxHTAbBgNVBAMTFGNsb3VkZmxhcmVhY2Nlc3MuY29tMIIBIjANBgkq\nhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArlZp3CRJEXocwc9QW8VxT8KJdyzdVG7Y\n0C8mQkTeo8stL/PoTGslIa5tNdI4ba1YZZJ9sUbPFbem+0Q0unwD/yYelm24pwEZ\nVBfC3rnyuN4b7gfitcSkeZrKlwnvU1iNz9KbsEFC7nGZWShp0zlDc20L8KPCBntY\no/hriLooyHtv/skirZ6evrGvNErC+Sn/lUzCKN6lz2sv4VxHMWGS7CBtHxZ/JbMv\ngOFRj1HAKenfcD0y1TsvgZ8l54eBHlAlzTPOkKcFa4Wg1icPV8QlTidjClA5cmk0\ngu1aj/cd1R+JGMgInelyvbkZj81CVxCX+1aNc/D7FcjeBFQyA0yw+wIDAQABMA0G\nCSqGSIb3DQEBCwUAA4IBAQAZelVRi7YCj2hRxeKNvp1P5n9EQbWAaUIXI5AMDThF\nVilxMrFuh6RZZGuCUjY7kOaVrHg+YEF5jYNAB3X0rNjbmnKFKV1GsW9ypV65x0Kz\naCtCWzeyOKgxcKoYv1bLxlOWTt0H4V4vgDDGXWuOV6e/mczay36tZjt/8AEC95ep\nZEXlJflkQ1oCnKQKyXtzAvIgKm2Y+l0Md/LXkp82EgcQ6GJJRCz9XM4oO3P0w04u\n7SeVB58DFnkETVOTDgTVKeKl3Z7+nirLG8Kjp/KPxHpEwVkciKS/woTT6BhwpfnF\nZY5p9Mi2OMnpGTkrG9dgeTt1wxkyOyUwgO2hguYwXSyq\n-----END CERTIFICATE-----\n"
    }
  ]
}
```

Verified: live, 2026-10-31, `curl https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs` for the deployment's team. 1 of 2 `keys` and 1 of 2 `public_certs` kept; the values are public keys.

### Error response

Unknown team domain:

```http
HTTP/2 404
content-type: text/html
server: cloudflare
```

```html
<!doctype html>
<html>
  <head>
    <title>Error ・ Cloudflare Access</title>
<!-- … -->
<h1 class="Card-title">Unable to find your Access organization!</h1>
<!-- … -->
```

Verified: live, 2026-10-31, `curl https://no-such-team-zz9q.cloudflareaccess.com/cdn-cgi/access/certs`. Head and heading kept, the rest of the 35 KB page omitted.

## 6. Data Mapping

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `$.keys[]` | `jose` imports each RSA key for `RS256` verification | the remote key set held by the authenticator | Not stored (isolate memory) |
| JWT payload `email` (verified with these keys) | trimmed, lower-cased (`ownerIdFromEmail`); must equal `OWNER_EMAIL` | `OwnerIdentity.ownerId` (`apps/api/src/auth.ts`), with `authMode: "cloudflare-access"` | Not stored; scopes every request's `owner_id` |

## 7. Maintenance

### Known differences between the runners

Not applicable: only the API Worker calls this endpoint.

### Open issues

- The deployment is locked and has not been signed into through Access (OPERATIONS.md, "Deploying to Cloudflare"); a full sign-in with a real `Cf-Access-Jwt-Assertion` has not been verified.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-31 | spec | The key fetch now goes through our `customFetch` wrapper (`jose` 6.2.12 passes its request options and rethrows the wrapper's error unchanged, `dist/webapi/jwks/remote.js`); failures mapped to `AUTH_KEYS_UNAVAILABLE`. No example changed. | Claude (external API defect fixes) |
| 2026-10-31 | live, spec | live: `GET /cdn-cgi/access/certs` for the deployment's team (200, key set) and an unknown team (404 HTML); spec: the request headers and the cache, cooldown and timeout defaults, read from the `jose` 6.2.12 source | Claude (orchestrator) |
