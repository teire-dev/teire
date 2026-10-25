/**
 * Maven version order (plan S08): a port of Maven 3.9's `ComparableVersion`, the rule Maven itself,
 * Gradle and every Maven repository sort by. A version splits into items at `.`, `-` and every
 * digit/letter boundary; `-` opens a sub-list; trailing zero/"ga"/"final"/"release" items vanish.
 * Qualifiers order alpha < beta < milestone < rc (= cr) < snapshot < release < sp, then any other
 * qualifier alphabetically (`33.0-android` < `33.0-jre`). Ranges: Maven's own (`[1.0,2.0)`,
 * `(,1.5]`, unions) and comparator lists as advisories write them (`>= 2.0, < 2.13.4.2`).
 */
type Item = { kind: "int"; value: bigint } | { kind: "str"; value: string } | { kind: "list"; items: Item[] };

const QUALIFIERS = ["alpha", "beta", "milestone", "rc", "snapshot", "", "sp"];
const ALIASES: Record<string, string> = { ga: "", final: "", release: "", cr: "rc" };
const RELEASE_INDEX = QUALIFIERS.indexOf("");

function qualifierKey(q: string) {
  const i = QUALIFIERS.indexOf(q);
  return i >= 0 ? `${i}` : `${QUALIFIERS.length}-${q}`;
}

function strItem(value: string, followedByDigit: boolean): Item {
  let v = value.toLowerCase();
  if (followedByDigit && v.length === 1)
    v = v === "a" ? "alpha" : v === "b" ? "beta" : v === "m" ? "milestone" : v;
  return { kind: "str", value: ALIASES[v] ?? v };
}

function isNull(item: Item): boolean {
  if (item.kind === "int") return item.value === 0n;
  if (item.kind === "str") return qualifierKey(item.value) === `${RELEASE_INDEX}`;
  return item.items.length === 0;
}

function normalize(list: Item[]) {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i] as Item;
    if (isNull(item)) list.splice(i, 1);
    else if (item.kind !== "list") break;
  }
}

export function parseMavenVersion(version: string): Item {
  const root: Item[] = [];
  let list = root;
  const stack: Item[][] = [root];
  const v = version.toLowerCase();
  let start = 0;
  let isDigit = false;
  const push = (token: string, followedByDigit: boolean) => {
    if (token === "") list.push({ kind: "int", value: 0n });
    else if (/^\d+$/.test(token)) list.push({ kind: "int", value: BigInt(token) });
    else list.push(strItem(token, followedByDigit));
  };
  for (let i = 0; i < v.length; i++) {
    const c = v[i] as string;
    if (c === ".") {
      push(v.slice(start, i), false);
      start = i + 1;
    } else if (c === "-") {
      push(v.slice(start, i), false);
      start = i + 1;
      const sub: Item[] = [];
      list.push({ kind: "list", items: sub });
      list = sub;
      stack.push(sub);
    } else if (/\d/.test(c)) {
      if (!isDigit && i > start) {
        push(v.slice(start, i), true);
        start = i;
        const sub: Item[] = [];
        list.push({ kind: "list", items: sub });
        list = sub;
        stack.push(sub);
      }
      isDigit = true;
    } else {
      if (isDigit && i > start) {
        push(v.slice(start, i), false);
        start = i;
        const sub: Item[] = [];
        list.push({ kind: "list", items: sub });
        list = sub;
        stack.push(sub);
      }
      isDigit = false;
    }
  }
  if (v.length > start) push(v.slice(start), false);
  for (let i = stack.length - 1; i >= 0; i--) normalize(stack[i] as Item[]);
  return { kind: "list", items: root };
}

function compareItem(a: Item | undefined, b: Item | undefined): number {
  if (a === undefined) {
    if (b === undefined) return 0;
    return -compareItem(b, undefined);
  }
  if (b === undefined) {
    if (a.kind === "int") return a.value === 0n ? 0 : 1;
    if (a.kind === "str")
      return qualifierKey(a.value).localeCompare(`${RELEASE_INDEX}`, "en", { numeric: true });
    for (const x of a.items) {
      const r = compareItem(x, undefined);
      if (r !== 0) return r;
    }
    return 0;
  }
  if (a.kind === "int") {
    if (b.kind === "int") return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    return 1;
  }
  if (a.kind === "str") {
    if (b.kind === "int" || b.kind === "list") return -1;
    return qualifierKey(a.value).localeCompare(qualifierKey(b.value), "en", { numeric: true });
  }
  if (b.kind === "int") return -1;
  if (b.kind === "str") return 1;
  const n = Math.max(a.items.length, b.items.length);
  for (let i = 0; i < n; i++) {
    const r = compareItem(a.items[i], b.items[i]);
    if (r !== 0) return r;
  }
  return 0;
}

export function compareMaven(a: string, b: string) {
  return Math.sign(compareItem(parseMavenVersion(a), parseMavenVersion(b)));
}

const PRERELEASE =
  /(?:^|[.\-_\d])(alpha|beta|milestone|rc|cr|snapshot|preview|ea|dev|incubating|[abm](?=\d))/i;

export function isMavenPrerelease(version: string) {
  return PRERELEASE.test(version);
}

/** Leading numeric release components (`33.4.0-jre` → [33, 4, 0]). */
export function mavenRelease(version: string) {
  return (/^\d+(?:\.\d+)*/.exec(version)?.[0] ?? "").split(".").filter(Boolean).map(Number);
}

/** The non-prerelease qualifier a version line is published under (`-jre`, `-android`), or "". */
export function mavenFlavor(version: string) {
  const q = version.slice((/^\d+(?:\.\d+)*/.exec(version)?.[0] ?? "").length).replace(/^[.-]/, "");
  const flavor = q.toLowerCase();
  return flavor && !isMavenPrerelease(flavor) && !(flavor in ALIASES) ? flavor : "";
}

function inMavenRange(version: string, range: string) {
  // Unions: `[1.0,1.2),[1.5,)`.
  const sets = range.match(/[[(][^\])]*[\])]/g);
  if (!sets) return compareMaven(version, range.trim()) === 0;
  return sets.some((set) => {
    const lowerInclusive = set.startsWith("[");
    const upperInclusive = set.endsWith("]");
    const body = set.slice(1, -1);
    if (!body.includes(",")) return compareMaven(version, body.trim()) === 0;
    const [lo, hi] = body.split(",").map((x) => x.trim());
    if (lo && (lowerInclusive ? compareMaven(version, lo) < 0 : compareMaven(version, lo) <= 0)) return false;
    if (hi && (upperInclusive ? compareMaven(version, hi) > 0 : compareMaven(version, hi) >= 0)) return false;
    return true;
  });
}

/** `>= 2.0, < 2.13.4.2` (GHSA, OSV) or a Maven range; a bare version is a soft requirement (always met). */
export function mavenSatisfies(version: string, range: string) {
  const r = range.trim();
  if (/^[[(]/.test(r)) return inMavenRange(version, r);
  const parts = r.split(/\s*,\s*/).filter(Boolean);
  if (parts.every((p) => /^(?:[<>]=?|=|!=)\s*\S+$/.test(p)))
    return parts.every((p) => {
      const m = /^([<>]=?|=|!=)\s*(\S+)$/.exec(p) as RegExpExecArray;
      const c = compareMaven(version, m[2] as string);
      switch (m[1]) {
        case "<":
          return c < 0;
        case "<=":
          return c <= 0;
        case ">":
          return c > 0;
        case ">=":
          return c >= 0;
        case "!=":
          return c !== 0;
        default:
          return c === 0;
      }
    });
  return true;
}
