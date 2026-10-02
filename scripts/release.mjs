// Cuts a release:   npm run release -- 0.2.0 [--push]
//
//   1. checks the git tree is clean and the CHANGELOG has an "Unreleased" section
//   2. sets the version in package.json (and package-lock.json)
//   3. renames "## [Unreleased]" in CHANGELOG.md to "## [0.2.0] - <date>" and adds a new empty one
//   4. runs `npm run verify` (typecheck, tests, build, package, package checks)
//   5. commits "Release v0.2.0" and tags v0.2.0
//   6. with --push: pushes the commit and the tag; GitHub Actions then publishes the release
//      (.github/workflows/release.yml), and installed plugins offer the update.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });
const out = (cmd) => execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
const fail = (msg) => {
    console.error(`release: ${msg}`);
    process.exit(1);
};

const version = process.argv[2];
const push = process.argv.includes("--push");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) fail("usage: npm run release -- <x.y.z> [--push]");
if (out("git status --porcelain")) fail("the working tree has uncommitted changes");
if (out(`git tag --list v${version}`)) fail(`tag v${version} already exists`);

const changelogPath = join(root, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
if (!/^## \[Unreleased\]/m.test(changelog)) fail('CHANGELOG.md needs a "## [Unreleased]" section describing the changes');
const date = new Date().toISOString().slice(0, 10);
writeFileSync(changelogPath, changelog.replace(/^## \[Unreleased\]/m, `## [Unreleased]\n\n## [${version}] - ${date}`));

run(`npm version ${version} --no-git-tag-version --allow-same-version`);
run("npm run verify");
run("git add package.json package-lock.json CHANGELOG.md");
run(`git commit -m "Release v${version}"`);
run(`git tag -a v${version} -m "Geekatplay 3D Layers v${version}"`);
if (push) {
    run("git push");
    run(`git push origin v${version}`);
    console.log(`\nPushed v${version}. GitHub Actions is publishing the release.`);
} else {
    console.log(`\nTagged v${version}. Publish with: git push && git push origin v${version}`);
}
