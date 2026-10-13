import { type EarningsCalendarEvent, earningsCalendarTexts, earningsDateForms } from "./ics.ts";

export type { EarningsCalendarEvent };

/**
 * "Add to Google Calendar" template link for one dated event: an all-day
 * event from the announcement date to the next day. Null when the event has
 * no usable date (undecided events cannot be templated). Summary and details
 * are the shared ICS text builder's output, percent-encoded.
 */
export function googleCalendarUrl(event: EarningsCalendarEvent): string | null {
	const forms = earningsDateForms(event.announcementDate);
	if (forms === null) return null;
	const { summary, description } = earningsCalendarTexts(event);
	const params =
		`action=TEMPLATE&text=${encodeURIComponent(summary)}` +
		`&dates=${forms.compact}/${forms.nextCompact}` +
		`&details=${encodeURIComponent(description)}`;
	return `https://calendar.google.com/calendar/render?${params}`;
}

/**
 * "Add to Outlook" compose link for one dated event (all-day, start date to
 * next day). Null when the event has no usable date. Same summary/body text
 * as the ICS writer.
 */
export function outlookCalendarUrl(event: EarningsCalendarEvent): string | null {
	const forms = earningsDateForms(event.announcementDate);
	if (forms === null) return null;
	const { summary, description } = earningsCalendarTexts(event);
	const params =
		"path=%2Fcalendar%2Faction%2Fcompose&rru=addevent" +
		`&subject=${encodeURIComponent(summary)}` +
		`&startdt=${forms.hyphen}&enddt=${forms.nextHyphen}&allday=true` +
		`&body=${encodeURIComponent(description)}`;
	return `https://outlook.live.com/calendar/0/deeplink/compose?${params}`;
}
