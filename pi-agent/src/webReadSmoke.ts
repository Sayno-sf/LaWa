import assert from "node:assert/strict";

import { readPublicGitHubPath, readPublicWebPage, searchPublicGitHubRepositories } from "./webReadTools.js";

const search = await searchPublicGitHubRepositories("mozilla readability");
assert.ok(search.repositories.length > 0);
const file = await readPublicGitHubPath("mozilla", "readability", "README.md");
assert.equal(file.kind, "file");
assert.match(file.text, /Readability/);
console.log(`Public GitHub read passed: ${file.url}`);
const page = await readPublicWebPage("https://developer.mozilla.org/en-US/docs/Web/JavaScript");
assert.match(page.text, /JavaScript/);
console.log(`Public web page read passed: ${page.url}`);
