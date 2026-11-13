# Sources for demand research

Investigated 2026-11-09 through the publishers' public pages. These are research
recommendations, not newly integrated feeds or tested API connections. The
current subscribed-feed corpus cannot provide comprehensive demand coverage.
A news aggregator is useful for discovery, but the original release must be read
and cited. Do not interpret article counts as demand strength.

| Priority / scope | Original source | Useful evidence | Interpretation and access limits |
| --- | --- | --- | --- |
| First: US manufacturing | [Census M3](https://www.census.gov/manufacturing/m3/index.html), [definitions](https://www.census.gov/manufacturing/m3/definitions/index.html) | Monthly new orders net of cancellations, unfilled orders, shipments and inventories | Compare orders, deliveries and inventory together. Dollar growth can reflect prices; backlog is not completed sales. Public tables; revised and seasonal/unadjusted series must be distinguished. |
| First: Japan manufacturing | [METI industrial production](https://www.meti.go.jp/english/statistics/tyo/iip/index.html) | Production, shipments, inventory and inventory ratios; downloadable Excel/CSV history | Shipments are a demand proxy, not final consumption. Check inventory accumulation, industry coverage, base year and revisions. |
| First: Japan equipment investment | [Cabinet Office machinery orders](https://www.esri.cao.go.jp/jp/stat/juchu/menu_juchu.html), [tables](https://www.esri.cao.go.jp/jp/stat/juchu/juchu.html) | Equipment orders by buyer category and order backlog | Separate domestic/private, government and overseas demand. State exclusions, including ships/electric power when using the core measure. Large orders can distort one month. |
| First: US consumer spending | [Census retail sales](https://www.census.gov/retail/sales.html) | Retail and food-services sales by business type | Nominal sales are not unit volumes: the publisher explicitly says these estimates are not adjusted for price changes. Retail does not cover the whole services economy. |
| First: energy consumption | [EIA electricity data documentation](https://www.eia.gov/opendata/documentation.php) | Electricity retail sales/consumption by sector and geography | Separate physical consumption, revenue and price; weather and seasonality can explain changes. API use has key and request requirements; no new integration is claimed here. |
| Sector confirmation: machine tools | [JMTBA statistics](https://www.jmtba.or.jp/english/category/machine-tool-statistics/), [Japanese statistics](https://www.jmtba.or.jp/statistics/) | Machine-tool orders and destination breakdowns | Industry association coverage, not all equipment investment. Check preliminary/final status, destination and currency; corroborate with Cabinet Office/METI. |
| Sector confirmation: semiconductors | [SIA market data / WSTS](https://www.semiconductors.org/data-resources/market-data/) | Shipment value, units and average selling prices | Separate actual shipments from forecasts and nominal value from volume/mix. Detailed WSTS series may require paid access; public headlines do not establish end-customer usage. |
| Sector confirmation: construction | [MLIT construction statistics](https://www.mlit.go.jp/statistics/details/kkoji_list.html), [construction activity](https://www.mlit.go.jp/sogoseisaku/jouhouka/sosei_jouhouka_tk4_000042.html) | Orders and construction activity | Award, start, work performed and completion are different events. Check public/private coverage, revisions and whether value reflects construction costs. |

## How to assemble a defensible demand story

1. Define product, geography, buyer, period and unit before searching. Use the
   closest direct measure: units consumed/sold, orders net of cancellations or
   actual customer spending. Production capacity and announced budgets measure
   supply or intent, not realized demand.
2. Pair a leading measure (orders, awarded contracts) with a realized measure
   (shipments, consumption, paid usage). Compare inventory, cancellation and
   price movements; include contrary evidence.
3. Read company filings and original earnings releases for company-specific
   unit sales, bookings and customer capital expenditure. Management guidance
   remains attributed guidance; a supplier's revenue does not establish its
   customer's final demand. Corroborate across independent data producers.
4. For a prospective sales opportunity, verify the buyer's original procurement
   notice, funded budget, location, eligibility and deadline. A statistical
   trend alone is not a qualified sales lead.
5. Record original URL, publisher, release date, observation period, units,
   currency, seasonal/inflation adjustment, preliminary/final status and the
   exact supporting passage. Check latest releases at execution time; do not
   mistake this source-directory review date for data freshness.

## Integration decision

Prioritize Census M3, METI and Cabinet Office series for broad manufacturing and
capital-goods research, then select consumption and sector sources for the
specific question. Keep trustworthy news reporting for context and discovery.
Do not add a statistical webpage to the RSS catalog as if it were a verified
feed. Any future automated ingestion needs its own verified endpoint examples,
licensing/rate-limit review and external-API document. No API subscriptions,
credentials, provider requests or database schema were added in this change.
