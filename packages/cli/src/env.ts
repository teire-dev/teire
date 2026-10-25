import { join } from "node:path";

// Imported first: the engine reads these when its modules load. The helpers' sources ship next to
// the bundle (scripts/build.mjs); uv and Go build them on first use, as in development.
process.env.TEIRE_PY_HELPER ??= join(import.meta.dirname, "helpers", "teire_py.py");
process.env.TEIRE_GO_HELPER_SRC ??= join(import.meta.dirname, "helpers", "go");
