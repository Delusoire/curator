import postcss from "https://esm.sh/postcss";
import { ensureDir } from "jsr:@std/fs/ensure-dir";

const DIST_THRESHOLD = 0.1 - Number.EPSILON;
const COMPLEXITY_CEILING = 100000;
const PENALTY_FN = (delta: number) => 1 - (1 / (1 + (delta / 2) ** 2));

const classRegex = /\b\w{20}\b/g;

const styles1 = parseCss(await Deno.readTextFile(Deno.args[0]));
const styles2 = parseCss(await Deno.readTextFile(Deno.args[1]));
const classes1 = parseClasses(styles1, classRegex);
const classes2 = parseClasses(styles2, classRegex);

console.log("✅ Styles parsed and loaded");

const selectors12DistSize = Object.keys(styles1).length *
	Object.keys(styles2).length;
const selectors12Dist: Record<Selector, Record<Selector, number>> = {};
let selectors12DistProgress = 0;
const selectors12DistProgressSize = Math.trunc(selectors12DistSize / 50);
for (const [selector1, properties1] of Object.entries(styles1)) {
	selectors12Dist[selector1] = {};
	for (const [selector2, properties2] of Object.entries(styles2)) {
		const dist = selectorDist(properties1, properties2);
		selectors12Dist[selector1][selector2] = dist;
		if (selectors12DistProgress++ % selectors12DistProgressSize === 0) {
			console.log(selectors12DistProgress / selectors12DistSize);
		}
	}
}

console.log("✅ Selectors distance matrix calculated");

const classes12DistSize = Object.keys(classes1).length *
	Object.keys(classes2).length;
const classes12Dist: Record<string, Record<string, number>> = {};
let classes12DistProgress = 0;
const classes12DistProgressSize = Math.trunc(classes12DistSize / 50);
for (const [class1, selectors1] of Object.entries(classes1)) {
	classes12Dist[class1] = {};
	for (const [class2, selectors2] of Object.entries(classes2)) {
		const selectorKeys1 = Object.keys(selectors1);
		const selectorKeys2 = Object.keys(selectors2);
		let minDist = 1;
		const max = Math.max(selectorKeys1.length, selectorKeys2.length);
		const delta = Math.abs(selectorKeys1.length - selectorKeys2.length);
		const alpha = delta / (max - delta);
		const penalty = PENALTY_FN(delta);
		for (const combination of zipCombinations(selectorKeys1, selectorKeys2)) {
			let totalDist = 0;
			let minDistWeight = 0;
			for (const [selector1, selector2] of combination) {
				const weight1 = selectors1[selector1];
				const weight2 = selectors2[selector2];
				const dist = selectors12Dist[selector1][selector2];
				const weight = Math.sqrt(weight1 * weight2);
				totalDist += dist * weight;
				minDistWeight += weight;
			}
			minDist = Math.min(minDist, totalDist / minDistWeight);
		}
		const dist = (minDist + penalty * alpha) / (1 + alpha);
		classes12Dist[class1][class2] = dist;
		if (classes12DistProgress++ % classes12DistProgressSize === 0) {
			console.log(classes12DistProgress / classes12DistSize);
		}
	}
}

console.log("✅ Classes distance matrix calculated");

const classPairsArray = Object.entries(classes12Dist)
	.flatMap(([class1, classes2Dist]) =>
		Object.entries(classes2Dist)
			.map(([class2, dist]) => [class1, class2, dist] as const)
	);

const classes1Keys = new Set(Object.keys(classes1));
const classes2Keys = new Set(Object.keys(classes2));
const selectedClassPairs = Object.entries(classes12Dist).map(
	([class1, classes2Dist]) => {
		const classes2DistArray = Object.entries(classes2Dist).toSorted(
			(a, b) => {
				let d = a[1] - b[1];
				if (d) {
					return d;
				}

				if (a[0] === class1) {
					d--;
				}
				if (b[0] === class1) {
					d++;
				}
				if (d) {
					return d;
				}

				if (classes1Keys.has(a[0])) {
					d++;
				}
				if (classes1Keys.has(b[0])) {
					d--;
				}
				return d;
			},
		);

		return [class1, ...classes2DistArray[0]] as const;
	},
);

const classPairs = Object.fromEntries(
	selectedClassPairs.filter(([, , dist]) => dist < DIST_THRESHOLD),
);

await ensureDir("out");
await Deno.writeTextFile(
	"out/all-pairs-dist.json",
	JSON.stringify(classPairsArray),
);
await Deno.writeTextFile("out/pairs.json", JSON.stringify(classPairs));

// ...

type Selector = string;
type Property = string;
type Value = string;
type Properties = Record<Property, Value>;
type Styles = Record<Selector, Properties>;

function parseCss(css: string): Styles {
	const root = postcss.parse(css);
	const styles: Record<string, Record<string, string>> = {};
	root.walkRules((rule) => {
		const selector = rule.selectors.join(",");
		styles[selector] = {};
		rule.walkDecls((decl) => {
			styles[selector][decl.prop] = decl.value;
		});
	});
	return styles;
}

function parseClasses(styles: Styles, classRegex: RegExp) {
	const classes: Record<string, Record<Selector, number>> = {};
	for (const selector of Object.keys(styles)) {
		let sum = 0;
		const classesSet = new Set<string>();
		for (const c of selector.matchAll(classRegex)) {
			classes[c[0]] ??= {};
			classes[c[0]][selector] ??= 0;
			classes[c[0]][selector]++;
			classesSet.add(c[0]);
			sum++;
		}
		for (const c of classesSet) {
			classes[c][selector] /= sum;
		}
	}
	return classes;
}

function selectorDist(properties1: Properties, properties2: Properties) {
	const props1 = new Set(Object.keys(properties1));
	const props2 = new Set(Object.keys(properties2));
	const intersection = props1.intersection(props2);
	const union = props1.union(props2);
	let totalDist = union.size - intersection.size;
	for (const prop of intersection) {
		const string1 = properties1[prop];
		const string2 = properties2[prop];
		totalDist += levenshteinDistance(string1, string2);
	}
	return totalDist / union.size;
}

function factorial(n: number): number {
	if (n === 0) {
		return 1;
	}
	return n * factorial(n - 1);
}

//! O(max!/(max-min)!)
function* zipCombinations<A, B>(
	as: A[],
	bs: B[],
	index = 0,
	current: [A, B][] = [],
): Generator<[A, B][]> {
	const minLength = Math.min(as.length, bs.length);
	if (index === 0) {
		const maxLength = Math.max(as.length, bs.length);
		const complexity = factorial(maxLength) /
			factorial(maxLength - minLength);
		if (complexity > COMPLEXITY_CEILING) {
			console.log("🔴 Too many combinations to calculate", complexity);
			return;
		}
	}

	if (current.length === minLength) {
		yield current;
		return;
	}

	for (let i = index; i < as.length; i++) {
		for (let j = 0; j < bs.length; j++) {
			if (!current.some((tuple) => tuple.includes(bs[j]))) {
				yield* zipCombinations(as, bs, i + 1, [...current, [as[i], bs[j]]]);
			}
		}
	}
}

function levenshteinDistance(string1: string, string2: string) {
	return levenshtein(string1, string2) /
		Math.max(string1.length, string2.length);
}

function levenshtein(a: string, b: string) {
	const an = a.length;
	const bn = b.length;
	if (an === 0) {
		return bn;
	}
	if (bn === 0) {
		return an;
	}

	const matrix = Array.from(
		{ length: an + 1 },
		(_, i) => Array(bn + 1).fill(0),
	);

	for (let i = 0; i <= an; i++) {
		matrix[i][0] = i;
	}
	for (let j = 0; j <= bn; j++) {
		matrix[0][j] = j;
	}

	for (let i = 1; i <= an; i++) {
		for (let j = 1; j <= bn; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1, // Deletion
				matrix[i][j - 1] + 1, // Insertion
				matrix[i - 1][j - 1] + cost, // Substitution
			);
		}
	}

	return matrix[an][bn];
}
