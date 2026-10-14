/**
 * Runner-side Google adapters (FR-019 section 2.2): OAuth, the loopback
 * listener, the token store and the Calendar client, over the narrow pinned
 * port. The shared `SafeFetcher` is untouched — this surface speaks POST/PUT
 * form and JSON bodies to exactly two hosts, which that port forbids.
 */

export {
	type CalendarCallDeps,
	type CalendarEventWrite,
	createCalendar,
	deleteEvent,
	type GetCalendarResult,
	type GoogleCallCode,
	type GoogleCallFailure,
	type GoogleCallResult,
	type GoogleRawHttp,
	getCalendar,
	type InsertResult,
	insertEvent,
	listManagedEvents,
	type ManagedCalendarEvent,
	updateEvent,
} from "./googleCalendarClient.ts";
export {
	createGoogleHttp,
	GOOGLE_CALENDAR_HOST,
	GOOGLE_MAX_BYTES,
	GOOGLE_OAUTH_HOST,
	GOOGLE_TIMEOUT_MS,
	type GoogleDnsLookup,
	type GoogleHttpDeps,
	type GoogleHttpError,
	type GoogleHttpErrorCode,
	type GoogleHttpMethod,
	type GoogleHttpRequest,
	type GoogleHttpResponse,
	type GoogleHttpResult,
	type GoogleTlsOverrides,
} from "./googleHttp.ts";
export {
	type LoopbackHandle,
	type LoopbackOptions,
	type LoopbackResult,
	startLoopbackListener,
} from "./googleLoopback.ts";
export {
	type AuthorizationUrlInput,
	buildAuthorizationUrl,
	codeChallengeS256,
	exchangeCode,
	GOOGLE_AUTH_ENDPOINT,
	GOOGLE_CALENDAR_SCOPE,
	type GoogleOAuthHttp,
	type GoogleStableCode,
	mapTokenFailure,
	newCodeVerifier,
	newOAuthState,
	refreshAccessToken,
	revokeToken,
	scopeGranted,
	type TokenExchangeInput,
	type TokenRefreshInput,
	type TokenSuccess,
} from "./googleOAuth.ts";
export {
	deleteGoogleTokenFile,
	type GoogleTokenRecord,
	readGoogleTokenFile,
	writeGoogleTokenFile,
} from "./googleTokenStore.ts";
