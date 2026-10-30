import bundle from "../../../../catalog/contributed.json" with { type: "json" };
import { type ChangeV2, changeV2 } from "../contract";

/**
 * Change records people contributed to the catalog (C13): each a JSON file in `catalog/changes/`,
 * validated in CI and bundled into `catalog/contributed.json`; the worker merges them on deploy and
 * the change page says who added each one.
 */
export const CONTRIBUTED: readonly ChangeV2[] = (bundle as unknown[]).map((r) => changeV2.parse(r));
