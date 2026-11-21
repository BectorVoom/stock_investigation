/** Price divided by reported annual EPS in the same currency. */
export function priceEarningsRatio(
	price: number,
	priceCurrency: string,
	eps: number,
	epsCurrency: string,
): number | null {
	if (
		priceCurrency !== epsCurrency ||
		!Number.isFinite(price) ||
		!Number.isFinite(eps) ||
		price <= 0 ||
		eps <= 0
	) {
		return null;
	}
	const ratio = price / eps;
	return Number.isFinite(ratio) ? ratio : null;
}
