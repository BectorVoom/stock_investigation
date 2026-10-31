-- Reference metadata displayed by earnings widgets. Existing stocks and events are untouched.
-- Restore the pre-migration backup to roll back; older code ignores this additive table.
CREATE TABLE earnings_sources (
 market TEXT NOT NULL PRIMARY KEY CHECK (market IN ('US', 'JP')),
 source TEXT NOT NULL CHECK (source IN ('finnhub', 'jpx')),
 publisher TEXT NOT NULL,
 source_url TEXT NOT NULL
) WITHOUT ROWID;
INSERT INTO earnings_sources VALUES
 ('US', 'finnhub', 'Finnhub', 'https://finnhub.io/'),
 ('JP', 'jpx', 'Japan Exchange Group (JPX)', 'https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html');
