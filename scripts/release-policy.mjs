import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  unlinkSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadReleaseManifest,
  setReleaseState
} from "./release-manifest.mjs";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANGE_DIRECTORY = ".changes";
const RELEASE_UNIT_ID = "codex-mcp-bridge";
const BUMP_RANK = { patch: 1, minor: 2, major: 3 };
const BASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CANDIDATE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/;
const RELEASE_BRANCH_PATTERN = /^release\/((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

export function loadChangeFragments(repoRoot = DEFAULT_REPO_ROOT) {
  const directory = path.join(repoRoot, CHANGE_DIRECTORY);
  if (!existsSync(directory)) {
    throw new Error(`${CHANGE_DIRECTORY} is missing.`);
  }
  const fragments = [];
  for (const name of readdirSync(directory).sort()) {
    if (name === "README.md") continue;
    if (!/^[a-z0-9][a-z0-9._-]*\.json$/.test(name)) {
      throw new Error(`Unexpected change-fragment entry: ${name}.`);
    }
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Change fragment ${name} must be a regular file.`);
    }
    let value;
    try {
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`Could not read change fragment ${name}: ${errorMessage(error)}`);
    }
    fragments.push({ name, file, ...validateChangeFragment(value, name) });
  }
  if (fragments.length > 200) throw new Error("At most 200 active change fragments are allowed.");
  return fragments;
}

export function validateChangeFragment(value, name = "fragment") {
  if (!isRecord(value)) throw new Error(`Change fragment ${name} must be an object.`);
  assertExactKeys(
    value,
    ["schemaVersion", "releaseUnitId", "bump", "summary", "breaking", "migration"],
    `Change fragment ${name}`
  );
  if (value.schemaVersion !== 1) throw new Error(`Change fragment ${name} schemaVersion must be 1.`);
  if (value.releaseUnitId !== RELEASE_UNIT_ID) {
    throw new Error(`Change fragment ${name} releaseUnitId must be ${RELEASE_UNIT_ID}.`);
  }
  if (!Object.hasOwn(BUMP_RANK, value.bump)) {
    throw new Error(`Change fragment ${name} bump must be patch, minor, or major.`);
  }
  singleLine(value.summary, `Change fragment ${name} summary`, 240);
  if (typeof value.breaking !== "boolean") {
    throw new Error(`Change fragment ${name} breaking must be boolean.`);
  }
  if (value.breaking) {
    if (!value.summary.startsWith("BREAKING:")) {
      throw new Error(`Breaking change fragment ${name} summary must start with BREAKING:.`);
    }
    singleLine(value.migration, `Breaking change fragment ${name} migration`, 500);
  } else if (value.migration !== null) {
    singleLine(value.migration, `Change fragment ${name} migration`, 500);
  }
  return {
    schemaVersion: value.schemaVersion,
    releaseUnitId: value.releaseUnitId,
    bump: value.bump,
    summary: value.summary,
    breaking: value.breaking,
    migration: value.migration
  };
}

export function deriveReleasePlan(manifest, fragments) {
  if (manifest.release.releaseUnitId !== RELEASE_UNIT_ID) {
    throw new Error(`Only the ${RELEASE_UNIT_ID} release unit is supported.`);
  }
  const highestBump = fragments.reduce(
    (current, fragment) => BUMP_RANK[fragment.bump] > BUMP_RANK[current] ? fragment.bump : current,
    "patch"
  );
  const breaking = fragments.some((fragment) => fragment.breaking);
  const stage = manifest.release.stage;

  if (stage === "development") {
    const current = baseVersionParts(manifest.release.version);
    if (!current) throw new Error("Development stage requires a suffix-free base version.");
    if (breaking && current.major === 0 && BUMP_RANK[highestBump] < BUMP_RANK.minor) {
      throw new Error("A breaking 0.x change requires at least a minor bump.");
    }
    if (breaking && current.major > 0 && highestBump !== "major") {
      throw new Error("A breaking 1.x-or-later change requires a major bump.");
    }
    const targetVersion = incrementVersion(current, highestBump);
    return {
      releaseUnitId: RELEASE_UNIT_ID,
      stage,
      currentVersion: manifest.release.version,
      bump: highestBump,
      breaking,
      fragmentCount: fragments.length,
      targetVersion,
      candidateVersion: `${targetVersion}-rc.1`,
      releaseBranch: `release/${targetVersion}`
    };
  }

  if (stage === "candidate") {
    const current = candidateVersionParts(manifest.release.version);
    if (!current) throw new Error("Candidate stage requires an X.Y.Z-rc.N version.");
    const source = baseVersionParts(manifest.release.sourceVersion);
    if (!source) throw new Error("Candidate stage requires its source development version.");
    if (breaking && source.major === 0 && BUMP_RANK[highestBump] < BUMP_RANK.minor) {
      throw new Error("A breaking 0.x change requires at least a minor bump.");
    }
    if (breaking && source.major > 0 && highestBump !== "major") {
      throw new Error("A breaking 1.x-or-later change requires a major bump.");
    }
    const fragmentTarget = incrementVersion(source, highestBump);
    if (fragmentTarget !== current.base) {
      throw new Error(
        `Active fragments now target ${fragmentTarget}, not ${current.base}; prepare a new release branch.`
      );
    }
    return {
      releaseUnitId: RELEASE_UNIT_ID,
      stage,
      currentVersion: manifest.release.version,
      bump: highestBump,
      breaking,
      fragmentCount: fragments.length,
      targetVersion: current.base,
      candidateVersion: `${current.base}-rc.${current.rc + 1}`,
      releaseBranch: `release/${current.base}`
    };
  }

  throw new Error(`A release plan cannot be created from ${stage} stage.`);
}

export function validateBranchStage(manifest, branch) {
  if (!branch) return { branch: "", stage: manifest.release.stage };
  const stage = manifest.release.stage;
  const version = manifest.release.version;
  if (branch === "dev") {
    if (stage !== "development") throw new Error("dev requires development stage.");
    return { branch, stage };
  }
  if (branch === "main") {
    if (stage !== "stable") throw new Error("main requires stable stage.");
    return { branch, stage };
  }
  const releaseBranch = RELEASE_BRANCH_PATTERN.exec(branch);
  if (releaseBranch) {
    if (stage !== "candidate" && stage !== "stable") {
      throw new Error("release/X.Y.Z requires candidate or stable stage.");
    }
    const base = candidateVersionParts(version)?.base ?? version;
    if (base !== releaseBranch[1]) {
      throw new Error(`Branch ${branch} does not match release version ${version}.`);
    }
    return { branch, stage };
  }
  if (stage === "candidate" || stage === "stable") {
    throw new Error(`${stage} stage is allowed only on release/X.Y.Z or main.`);
  }
  return { branch, stage };
}

export function deriveWorkflowContext(manifest, input) {
  const {
    eventName,
    refName,
    headRef = "",
    baseRef = "",
    repository = "",
    headRepository = ""
  } = input;
  if (eventName === "pull_request") {
    if (baseRef !== "main") {
      throw new Error("Release pull requests must target main.");
    }
    if (!RELEASE_BRANCH_PATTERN.test(headRef)) {
      throw new Error("Release pull requests must originate from release/X.Y.Z.");
    }
    if (!repository || headRepository !== repository) {
      throw new Error("Release pull requests must originate from the same repository.");
    }
    validateBranchStage(manifest, headRef);
    if (manifest.release.stage !== "candidate" && manifest.release.stage !== "stable") {
      throw new Error("Release pull requests require candidate or stable stage.");
    }
    return {
      mode: `${manifest.release.stage}-pr`,
      stage: manifest.release.stage,
      channel: manifest.release.channel,
      prerelease: manifest.release.stage === "candidate",
      publish: false,
      refName: headRef,
      baseRef
    };
  }
  validateBranchStage(manifest, refName);
  if (eventName === "workflow_dispatch") {
    if (manifest.release.stage !== "candidate" || !RELEASE_BRANCH_PATTERN.test(refName)) {
      throw new Error("Manual release runs require candidate stage on release/X.Y.Z.");
    }
    return {
      mode: "candidate",
      stage: "candidate",
      channel: "prerelease",
      prerelease: true,
      publish: true,
      refName
    };
  }
  if (eventName === "push") {
    if (refName !== "main" || manifest.release.stage !== "stable") {
      throw new Error("Stable release runs require stable stage on main.");
    }
    return {
      mode: "stable",
      stage: "stable",
      channel: "stable",
      prerelease: false,
      publish: true,
      refName
    };
  }
  throw new Error(`Unsupported release event: ${eventName || "(empty)"}.`);
}

export function prepareCandidate(repoRoot = DEFAULT_REPO_ROOT, branch = currentBranch(repoRoot)) {
  const manifest = loadReleaseManifest(repoRoot);
  const fragments = loadChangeFragments(repoRoot);
  const plan = deriveReleasePlan(manifest, fragments);
  if (manifest.release.stage !== "development") {
    throw new Error("prepare-candidate requires development stage.");
  }
  if (branch !== plan.releaseBranch) {
    throw new Error(`Create and switch to ${plan.releaseBranch} before preparing the candidate.`);
  }
  return setReleaseState(
    {
      version: plan.candidateVersion,
      stage: "candidate",
      sourceVersion: manifest.release.version,
      sourceCandidate: null
    },
    repoRoot
  );
}

export function prepareNextCandidate(repoRoot = DEFAULT_REPO_ROOT, branch = currentBranch(repoRoot)) {
  const manifest = loadReleaseManifest(repoRoot);
  const plan = deriveReleasePlan(manifest, loadChangeFragments(repoRoot));
  if (manifest.release.stage !== "candidate") throw new Error("next-rc requires candidate stage.");
  if (branch !== plan.releaseBranch) throw new Error(`next-rc must run on ${plan.releaseBranch}.`);
  return setReleaseState(
    {
      version: plan.candidateVersion,
      stage: "candidate",
      sourceVersion: manifest.release.sourceVersion,
      sourceCandidate: null
    },
    repoRoot
  );
}

export function promoteStable(repoRoot = DEFAULT_REPO_ROOT, branch = currentBranch(repoRoot)) {
  const manifest = loadReleaseManifest(repoRoot);
  const candidate = candidateVersionParts(manifest.release.version);
  if (manifest.release.stage !== "candidate" || !candidate) {
    throw new Error("promote requires candidate stage.");
  }
  const expectedBranch = `release/${candidate.base}`;
  if (branch !== expectedBranch) throw new Error(`promote must run on ${expectedBranch}.`);
  const fragments = loadChangeFragments(repoRoot);
  const metadata = setReleaseState(
    {
      version: candidate.base,
      stage: "stable",
      sourceVersion: manifest.release.sourceVersion,
      sourceCandidate: manifest.release.version
    },
    repoRoot
  );
  for (const fragment of fragments) unlinkSync(fragment.file);
  return { ...metadata, consumedFragments: fragments.map((fragment) => fragment.name) };
}

export function returnToDevelopment(repoRoot = DEFAULT_REPO_ROOT, branch = currentBranch(repoRoot)) {
  const manifest = loadReleaseManifest(repoRoot);
  if (branch !== "dev") throw new Error("development reset must run on dev.");
  if (manifest.release.stage !== "stable") {
    throw new Error("development reset requires a merged stable release state.");
  }
  return setReleaseState(
    {
      version: manifest.release.version,
      stage: "development",
      sourceVersion: null,
      sourceCandidate: null
    },
    repoRoot
  );
}

function checkPolicy(repoRoot = DEFAULT_REPO_ROOT) {
  const manifest = loadReleaseManifest(repoRoot);
  const fragments = loadChangeFragments(repoRoot);
  validateBranchStage(manifest, currentBranch(repoRoot));
  if (manifest.release.stage === "development" || manifest.release.stage === "candidate") {
    deriveReleasePlan(manifest, fragments);
  }
  if (manifest.release.stage === "stable" && fragments.length > 0) {
    throw new Error("Stable stage cannot retain active change fragments.");
  }
  return { manifest, fragments };
}

export function resolvePolicyBranch(environment = process.env) {
  if (environment.GITHUB_EVENT_NAME === "pull_request" && environment.GITHUB_HEAD_REF) {
    return environment.GITHUB_HEAD_REF;
  }
  return environment.GITHUB_REF_NAME ?? "";
}

function currentBranch(repoRoot) {
  const workflowBranch = resolvePolicyBranch();
  if (workflowBranch) return workflowBranch;
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
  } catch {
    return "";
  }
}

function incrementVersion(current, bump) {
  if (bump === "major") return `${current.major + 1}.0.0`;
  if (bump === "minor") return `${current.major}.${current.minor + 1}.0`;
  return `${current.major}.${current.minor}.${current.patch + 1}`;
}

function baseVersionParts(version) {
  const match = typeof version === "string" ? BASE_VERSION_PATTERN.exec(version) : null;
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function candidateVersionParts(version) {
  const match = typeof version === "string" ? CANDIDATE_VERSION_PATTERN.exec(version) : null;
  if (!match) return null;
  return {
    base: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: Number(match[4])
  };
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(", ")}.`);
  }
}

function singleLine(value, label, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} must be a single-line string of at most ${maxLength} characters.`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printOutput(value) {
  for (const [key, entry] of Object.entries(value)) {
    process.stdout.write(`${key}=${String(entry)}\n`);
  }
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === "check") {
    const { manifest, fragments } = checkPolicy();
    console.log(
      `Release policy is valid for ${manifest.release.stage} stage with ${fragments.length} active fragment(s).`
    );
    return;
  }
  if (command === "plan") {
    const manifest = loadReleaseManifest();
    console.log(JSON.stringify(deriveReleasePlan(manifest, loadChangeFragments()), null, 2));
    return;
  }
  if (command === "prepare-candidate") {
    const metadata = prepareCandidate();
    console.log(`Prepared ${metadata.version} on release/${candidateVersionParts(metadata.version).base}.`);
    return;
  }
  if (command === "next-rc") {
    const metadata = prepareNextCandidate();
    console.log(`Prepared ${metadata.version}.`);
    return;
  }
  if (command === "promote") {
    const metadata = promoteStable();
    console.log(
      `Promoted ${metadata.sourceCandidate} to ${metadata.version}; consumed ${metadata.consumedFragments.length} fragment(s).`
    );
    return;
  }
  if (command === "development") {
    const metadata = returnToDevelopment();
    console.log(`Returned ${metadata.version} to development stage.`);
    return;
  }
  if (command === "assert-stage") {
    const manifest = loadReleaseManifest();
    if (manifest.release.stage !== argument) {
      throw new Error(`Expected ${argument} stage, found ${manifest.release.stage}.`);
    }
    validateBranchStage(manifest, currentBranch(DEFAULT_REPO_ROOT));
    console.log(`Release stage is ${argument}.`);
    return;
  }
  if (command === "github-context") {
    const manifest = loadReleaseManifest();
    const context = deriveWorkflowContext(manifest, {
      eventName: process.env.GITHUB_EVENT_NAME ?? "",
      refName: process.env.GITHUB_REF_NAME ?? "",
      headRef: process.env.GITHUB_HEAD_REF ?? "",
      baseRef: process.env.GITHUB_BASE_REF ?? "",
      repository: process.env.GITHUB_REPOSITORY ?? "",
      headRepository: process.env.RELEASE_PR_HEAD_REPOSITORY ?? ""
    });
    printOutput(context);
    return;
  }
  throw new Error(
    "Usage: release-policy.mjs <check|plan|prepare-candidate|next-rc|promote|development|assert-stage|github-context> [stage]"
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
