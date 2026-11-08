import assert from "node:assert/strict";

import { searchAnySearchWeb } from "./anySearchTools.js";

const result = await searchAnySearchWeb("MDN JavaScript guide");
assert.ok(result.results.length > 0, "AnySearch returned no public HTTPS search results");
console.log(`Anonymous AnySearch passed: ${result.results.length} public results; first source ${result.results[0]?.url}`);
