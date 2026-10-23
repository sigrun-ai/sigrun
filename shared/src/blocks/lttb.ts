/**
 * Largest-triangle-three-buckets downsampling (UI-blocks spec §5.4):
 * the display-side downsample channels apply to line and area series
 * (at most 2,000 points per series on the wire; a channel shows fewer).
 *
 * Pure: returns a fresh array of fresh tuples; never mutates `points`.
 */

type Point = [number, number];

/**
 * Downsample `points` to at most `threshold` points, always keeping the
 * first and the last point. The interior is bucketed into `threshold -
 * 2` buckets; each bucket keeps the point forming the largest triangle
 * with the previously selected point and the next bucket's average —
 * which preserves visual shape (peaks and troughs) rather than
 * sampling on a fixed interval.
 */
export function lttb(
	points: readonly (readonly [number, number])[],
	threshold: number,
): [number, number][] {
	const count = points.length;
	if (count === 0 || threshold <= 0) return [];
	if (threshold === 1) return [[points[0][0], points[0][1]]];
	if (threshold === 2) {
		return [
			[points[0][0], points[0][1]],
			[count === 1 ? points[0][0] : points[count - 1][0],
			 count === 1 ? points[0][1] : points[count - 1][1]],
		];
	}
	if (threshold >= count) {
		return points.map((point): Point => [point[0], point[1]]);
	}

	const sampled: Point[] = [[points[0][0], points[0][1]]];
	const bucketSize = (count - 2) / (threshold - 2);

	for (let bucket = 0; bucket < threshold - 2; bucket++) {
		const start = Math.floor(1 + bucket * bucketSize);
		const end = Math.min(Math.floor(1 + (bucket + 1) * bucketSize), count - 1);

		// The average of the NEXT bucket's points — the third corner of
		// every candidate triangle. The last bucket averages the final
		// point's window [count-1, count).
		const nextStart = end;
		const nextEnd = Math.min(Math.floor(1 + (bucket + 2) * bucketSize), count);
		let avgX = 0;
		let avgY = 0;
		for (let i = nextStart; i < nextEnd; i++) {
			avgX += points[i][0];
			avgY += points[i][1];
		}
		avgX /= nextEnd - nextStart;
		avgY /= nextEnd - nextStart;

		const previous = sampled[sampled.length - 1];
		let bestArea = -1;
		let bestIndex = start;
		for (let i = start; i < end; i++) {
			// Twice the signed area of the triangle (previous, candidate,
			// average) — the factor is constant, so abs is enough to rank.
			const area = Math.abs(
				(previous[0] - avgX) * (points[i][1] - previous[1]) -
					(previous[0] - points[i][0]) * (avgY - previous[1]),
			);
			if (area > bestArea) {
				bestArea = area;
				bestIndex = i;
			}
		}
		sampled.push([points[bestIndex][0], points[bestIndex][1]]);
	}

	sampled.push([points[count - 1][0], points[count - 1][1]]);
	return sampled;
}
