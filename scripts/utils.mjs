// Contains utility functions for various scripts, including:
// CI, running tests, and code generation.

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { hostname, tmpdir as nodeTmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { normalize as normalizeWindows } from "node:path/win32";

export const isWindows = process.platform === "win32";
export const isMacOS = process.platform === "darwin";
export const isLinux = process.platform === "linux";
export const isPosix = isMacOS || isLinux;

/**
 * @param {string} name
 * @param {boolean} [required]
 * @returns {string}
 */
export function getEnv(name, required = true) {
  const value = process.env[name];

  if (required && !value) {
    throw new Error(`Environment variable is missing: ${name}`);
  }

  return value;
}

export const isBuildkite = getEnv("BUILDKITE", false) === "true";
export const isGithubAction = getEnv("GITHUB_ACTIONS", false) === "true";
export const isCI = getEnv("CI", false) === "true" || isBuildkite || isGithubAction;
export const isDebug = getEnv("DEBUG", false) === "1";

/**
 * @param {string} name
 * @param {object} [options]
 * @param {boolean} [options.required]
 * @param {boolean} [options.redact]
 * @returns {string}
 */
export function getSecret(name, options = { required: true, redact: true }) {
  const value = getEnv(name, false);
  if (value) {
    return value;
  }

  if (isBuildkite) {
    const command = ["buildkite-agent", "secret", "get", name];
    if (options["redact"] === false) {
      command.push("--skip-redaction");
    }

    const { error, stdout: secret } = spawnSync(command);
    if (error || !secret.trim()) {
      const orgId = getEnv("BUILDKITE_ORGANIZATION_SLUG", false);
      const clusterId = getEnv("BUILDKITE_CLUSTER_ID", false);

      let hint;
      if (orgId && clusterId) {
        hint = `https://buildkite.com/organizations/${orgId}/clusters/${clusterId}/secrets`;
      } else {
        hint = "https://buildkite.com/docs/pipelines/buildkite-secrets";
      }

      throw new Error(`Secret not found: ${name} (hint: go to ${hint} and create a secret)`, { cause: error });
    }

    setEnv(name, secret);
    return secret;
  }

  return getEnv(name, options["required"]);
}

/**
 * @param  {...unknown} args
 */
export function debugLog(...args) {
  if (isDebug) {
    console.log(...args);
  }
}

/**
 * @param {string} name
 * @param {string | undefined} value
 */
export function setEnv(name, value) {
  process.env[name] = value;

  if (isGithubAction && !/^GITHUB_/i.test(name)) {
    const envFilePath = process.env["GITHUB_ENV"];
    if (envFilePath) {
      const delimeter = Math.random().toString(36).substring(2, 15);
      const content = `${name}<<${delimeter}\n${value}\n${delimeter}\n`;
      appendFileSync(outputPath, content);
    }
  }
}

/**
 * @typedef {object} SpawnOptions
 * @property {string} [cwd]
 * @property {number} [timeout]
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [stdout]
 * @property {string} [stderr]
 */

/**
 * @typedef {object} SpawnResult
 * @property {number} exitCode
 * @property {number} [signalCode]
 * @property {string} stdout
 * @property {string} stderr
 * @property {Error} [error]
 */

/**
 * @param {string[]} command
 * @param {SpawnOptions} options
 * @returns {Promise<SpawnResult>}
 */
export async function spawn(command, options = {}) {
  debugLog("$", ...command);

  const [cmd, ...args] = command;
  const spawnOptions = {
    cwd: options["cwd"] ?? process.cwd(),
    timeout: options["timeout"] ?? undefined,
    env: options["env"] ?? undefined,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  };

  let exitCode = 1;
  let signalCode;
  let stdout = "";
  let stderr = "";
  let error;

  const result = new Promise((resolve, reject) => {
    const subprocess = nodeSpawn(cmd, args, spawnOptions);

    subprocess.stdout?.on("data", chunk => {
      stdout += chunk;
    });
    subprocess.stderr?.on("data", chunk => {
      stderr += chunk;
    });

    subprocess.on("error", error => reject(error));
    subprocess.on("exit", (code, signal) => {
      exitCode = code;
      signalCode = signal;
      resolve();
    });
  });

  try {
    await result;
  } catch (cause) {
    error = cause;
  }

  if (exitCode !== 0 && isWindows) {
    const exitReason = getWindowsExitReason(exitCode);
    if (exitReason) {
      exitCode = exitReason;
    }
  }

  if (error || signalCode || exitCode !== 0) {
    const description = command.map(arg => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ");
    const cause = error || stderr.trim() || stdout.trim() || undefined;

    if (signalCode) {
      error = new Error(`Command killed with ${signalCode}: ${description}`, { cause });
    } else {
      error = new Error(`Command exited with code ${exitCode}: ${description}`, { cause });
    }
  }

  return {
    exitCode,
    signalCode,
    stdout,
    stderr,
    error,
  };
}

/**
 * @param {string[]} command
 * @param {SpawnOptions} options
 * @returns {Promise<SpawnResult>}
 */
export async function spawnSafe(command, options) {
  const result = await spawn(command, options);

  const { error } = result;
  if (error) {
    throw error;
  }

  return result;
}

/**
 * @param {string[]} command
 * @param {SpawnOptions} options
 * @returns {SpawnResult}
 */
export function spawnSync(command, options = {}) {
  debugLog("$", ...command);

  const [cmd, ...args] = command;
  const spawnOptions = {
    cwd: options["cwd"] ?? process.cwd(),
    timeout: options["timeout"] ?? undefined,
    env: options["env"] ?? undefined,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  };

  let exitCode = 1;
  let signalCode;
  let stdout = "";
  let stderr = "";
  let error;

  let result;
  try {
    result = nodeSpawnSync(cmd, args, spawnOptions);
  } catch (error) {
    result = { error };
  }

  const { error: spawnError, status, signal, stdout: stdoutBuffer, stderr: stderrBuffer } = result;
  if (spawnError) {
    error = spawnError;
  } else {
    exitCode = status ?? 1;
    signalCode = signal || undefined;
    stdout = stdoutBuffer.toString();
    stderr = stderrBuffer.toString();
  }

  if (exitCode !== 0 && isWindows) {
    const exitReason = getWindowsExitReason(exitCode);
    if (exitReason) {
      exitCode = exitReason;
    }
  }

  if (error || signalCode || exitCode !== 0) {
    const description = command.map(arg => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ");
    const cause = error || stderr.trim() || stdout.trim() || undefined;

    if (signalCode) {
      error = new Error(`Command killed with ${signalCode}: ${description}`, { cause });
    } else {
      error = new Error(`Command exited with code ${exitCode}: ${description}`, { cause });
    }
  }

  return {
    exitCode,
    signalCode,
    stdout,
    stderr,
    error,
  };
}

/**
 * @param {string[]} command
 * @param {SpawnOptions} options
 * @returns {SpawnResult}
 */
export function spawnSyncSafe(command, options) {
  const result = spawnSync(command, options);

  const { error } = result;
  if (error) {
    throw error;
  }

  return result;
}

/**
 * @param {number} exitCode
 * @returns {string | undefined}
 */
export function getWindowsExitReason(exitCode) {
  const ntStatusPath = "C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.22621.0\\shared\\ntstatus.h";
  const nthStatus = readFile(ntStatusPath, { cache: true });

  const match = nthStatus.match(new RegExp(`(STATUS_\\w+).*0x${exitCode?.toString(16)}`, "i"));
  if (match) {
    const [, exitReason] = match;
    return exitReason;
  }
}

/**
 * @param {string} url
 * @returns {URL}
 */
export function parseGitUrl(url) {
  const string = typeof url === "string" ? url : url.toString();

  const githubUrl = getEnv("GITHUB_SERVER_URL", false) || "https://github.com";
  if (/^git@github\.com:/.test(string)) {
    return new URL(string.slice(15).replace(/\.git$/, ""), githubUrl);
  }
  if (/^https:\/\/github\.com\//.test(string)) {
    return new URL(string.slice(19).replace(/\.git$/, ""), githubUrl);
  }

  throw new Error(`Unsupported git url: ${string}`);
}

/**
 * @param {string} [cwd]
 * @returns {URL | undefined}
 */
export function getRepositoryUrl(cwd) {
  if (!cwd) {
    if (isBuildkite) {
      const repository = getEnv("BUILDKITE_PULL_REQUEST_REPO", false) || getEnv("BUILDKITE_REPO", false);
      if (repository) {
        return parseGitUrl(repository);
      }
    }

    if (isGithubAction) {
      const serverUrl = getEnv("GITHUB_SERVER_URL", false) || "https://github.com";
      const repository = getEnv("GITHUB_REPOSITORY", false);
      if (serverUrl && repository) {
        return parseGitUrl(new URL(repository, serverUrl));
      }
    }
  }

  const { error, stdout } = spawnSync(["git", "remote", "get-url", "origin"], { cwd });
  if (!error) {
    return parseGitUrl(stdout.trim());
  }
}

/**
 * @param {string} [cwd]
 * @returns {string | undefined}
 */
export function getRepository(cwd) {
  if (!cwd) {
    if (isGithubAction) {
      const repository = getEnv("GITHUB_REPOSITORY", false);
      if (repository) {
        return repository;
      }
    }
  }

  const url = getRepositoryUrl(cwd);
  if (url) {
    const { hostname, pathname } = new URL(url);
    if (hostname == "github.com") {
      return pathname.slice(1);
    }
  }
}

/**
 * @param {string} [cwd]
 * @returns {string | undefined}
 */
export function getRepositoryOwner(cwd) {
  const repository = getRepository(cwd);
  if (repository) {
    const [owner] = repository.split("/");
    if (owner) {
      return owner;
    }
  }
}

/**
 * @param {string} [cwd]
 * @returns {string | undefined}
 */
export function getCommit(cwd) {
  if (!cwd) {
    if (isBuildkite) {
      const commit = getEnv("BUILDKITE_COMMIT", false);
      if (commit) {
        return commit;
      }
    }

    if (isGithubAction) {
      const commit = getEnv("GITHUB_SHA", false);
      if (commit) {
        return commit;
      }
    }
  }

  const { error, stdout } = spawnSync(["git", "rev-parse", "HEAD"], { cwd });
  if (!error) {
    return stdout.trim();
  }
}

/**
 * @param {string} [cwd]
 * @returns {string | undefined}
 */
export function getCommitMessage(cwd) {
  if (!cwd) {
    if (isBuildkite) {
      const message = getEnv("BUILDKITE_MESSAGE", false);
      if (message) {
        return message;
      }
    }
  }

  const { error, stdout } = spawnSync(["git", "log", "-1", "--pretty=%B"], { cwd });
  if (!error) {
    return stdout.trim();
  }
}

/**
 * @param {string} [cwd]
 * @returns {string | undefined}
 */
export function getBranch(cwd) {
  if (!cwd) {
    if (isBuildkite) {
      const branch = getEnv("BUILDKITE_BRANCH", false);
      if (branch) {
        return branch;
      }
    }

    if (isGithubAction) {
      const ref = getEnv("GITHUB_REF_NAME", false);
      if (ref) {
        return ref;
      }
    }
  }

  const { error, stdout } = spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  if (!error) {
    return stdout.trim();
  }
}

/**
 * @param {string} [cwd]
 * @returns {string}
 */
export function getMainBranch(cwd) {
  if (!cwd) {
    if (isBuildkite) {
      const branch = getEnv("BUILDKITE_PIPELINE_DEFAULT_BRANCH", false);
      if (branch) {
        return branch;
      }
    }

    if (isGithubAction) {
      const headRef = getEnv("GITHUB_HEAD_REF", false);
      if (headRef) {
        return headRef;
      }
    }
  }

  const { error, stdout } = spawnSync(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], { cwd });
  if (!error) {
    return stdout.trim().replace("refs/remotes/origin/", "");
  }
}

/**
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function isMainBranch(cwd) {
  return !isFork(cwd) && getBranch(cwd) === getMainBranch(cwd);
}

/**
 * @returns {boolean}
 */
export function isPullRequest() {
  if (isBuildkite) {
    return !isNaN(parseInt(getEnv("BUILDKITE_PULL_REQUEST", false)));
  }

  if (isGithubAction) {
    return /pull_request|merge_group/.test(getEnv("GITHUB_EVENT_NAME", false));
  }

  return false;
}

/**
 * @returns {number | undefined}
 */
export function getPullRequest() {
  if (isBuildkite) {
    const pullRequest = getEnv("BUILDKITE_PULL_REQUEST", false);
    if (pullRequest) {
      return parseInt(pullRequest);
    }
  }

  if (isGithubAction) {
    const eventPath = getEnv("GITHUB_EVENT_PATH", false);
    if (eventPath && existsSync(eventPath)) {
      const event = JSON.parse(readFile(eventPath, { cache: true }));
      const pullRequest = event["pull_request"];
      if (pullRequest) {
        return parseInt(pullRequest["number"]);
      }
    }
  }
}

/**
 * @returns {string | undefined}
 */
export function getTargetBranch() {
  if (isPullRequest()) {
    if (isBuildkite) {
      return getEnv("BUILDKITE_PULL_REQUEST_BASE_BRANCH", false);
    }

    if (isGithubAction) {
      return getEnv("GITHUB_BASE_REF", false);
    }
  }
}

/**
 * @returns {boolean}
 */
export function isFork() {
  if (isBuildkite) {
    const repository = getEnv("BUILDKITE_PULL_REQUEST_REPO", false);
    return !!repository && repository !== getEnv("BUILDKITE_REPO", false);
  }

  if (isGithubAction) {
    const eventPath = getEnv("GITHUB_EVENT_PATH", false);
    if (eventPath && existsSync(eventPath)) {
      const event = JSON.parse(readFile(eventPath, { cache: true }));
      const pullRequest = event["pull_request"];
      if (pullRequest) {
        return !!pullRequest["head"]["repo"]["fork"];
      }
    }
  }

  return false;
}

/**
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function isMergeQueue(cwd) {
  return /^gh-readonly-queue/.test(getBranch(cwd));
}

/**
 * @returns {string | undefined}
 */
export function getGithubToken() {
  const cachedToken = getSecret("GITHUB_TOKEN", { required: false });

  if (typeof cachedToken === "string") {
    return cachedToken || undefined;
  }

  const { error, stdout } = spawnSync(["gh", "auth", "token"]);
  const token = error ? "" : stdout.trim();

  setEnv("GITHUB_TOKEN", token);
  return token || undefined;
}

/**
 * @typedef {object} CurlOptions
 * @property {string} [method]
 * @property {string} [body]
 * @property {Record<string, string | undefined>} [headers]
 * @property {number} [timeout]
 * @property {number} [retries]
 * @property {boolean} [json]
 * @property {boolean} [arrayBuffer]
 * @property {string} [filename]
 */

/**
 * @typedef {object} CurlResult
 * @property {number} status
 * @property {string} statusText
 * @property {Error | undefined} error
 * @property {any} body
 */

/**
 * @param {string} url
 * @param {CurlOptions} [options]
 * @returns {Promise<CurlResult>}
 */
export async function curl(url, options = {}) {
  let { hostname, href } = new URL(url);
  let method = options["method"] || "GET";
  let input = options["body"];
  let headers = options["headers"] || {};
  let retries = options["retries"] || 3;
  let json = options["json"];
  let arrayBuffer = options["arrayBuffer"];
  let filename = options["filename"];

  if (typeof headers["Authorization"] === "undefined") {
    if (hostname === "api.github.com" || hostname === "uploads.github.com") {
      const githubToken = getGithubToken();
      if (githubToken) {
        headers["Authorization"] = `Bearer ${githubToken}`;
      }
    }
  }

  let status;
  let statusText;
  let body;
  let error;
  for (let i = 0; i < retries; i++) {
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }

    let response;
    try {
      response = await fetch(href, { method, headers, body: input });
    } catch (cause) {
      debugLog("$", "curl", href, "-> error");
      error = new Error(`Fetch failed: ${method} ${url}`, { cause });
      continue;
    }

    status = response["status"];
    statusText = response["statusText"];
    debugLog("$", "curl", href, "->", status, statusText);

    const ok = response["ok"];
    try {
      if (filename && ok) {
        const buffer = await response.arrayBuffer();
        await writeFile(filename, new Uint8Array(buffer));
      } else if (arrayBuffer && ok) {
        body = await response.arrayBuffer();
      } else if (json && ok) {
        body = await response.json();
      } else {
        body = await response.text();
      }
    } catch (cause) {
      error = new Error(`Fetch failed: ${method} ${url}`, { cause });
      continue;
    }

    if (response["ok"]) {
      break;
    }

    error = new Error(`Fetch failed: ${method} ${url}: ${status} ${statusText}`, { cause: body });

    if (status === 400 || status === 404 || status === 422) {
      break;
    }
  }

  return {
    status,
    statusText,
    error,
    body,
  };
}

/**
 * @param {string} url
 * @param {CurlOptions} options
 * @returns {Promise<any>}
 */
export async function curlSafe(url, options) {
  const result = await curl(url, options);

  const { error, body } = result;
  if (error) {
    throw error;
  }

  return body;
}

let cachedFiles;

/**
 * @param {string} filename
 * @param {object} [options]
 * @param {boolean} [options.cache]
 * @returns {string}
 */
export function readFile(filename, options = {}) {
  const absolutePath = resolve(filename);
  if (options["cache"]) {
    if (cachedFiles?.[absolutePath]) {
      return cachedFiles[absolutePath];
    }
  }

  const relativePath = relative(process.cwd(), absolutePath);
  debugLog("cat", relativePath);

  let content;
  try {
    content = readFileSync(absolutePath, "utf-8");
  } catch (cause) {
    throw new Error(`Read failed: ${relativePath}`, { cause });
  }

  if (options["cache"]) {
    cachedFiles ||= {};
    cachedFiles[absolutePath] = content;
  }

  return content;
}

/**
 * @param {string} [cwd]
 * @param {string} [base]
 * @param {string} [head]
 * @returns {Promise<string[] | undefined>}
 */
export async function getChangedFiles(cwd, base, head) {
  const repository = getRepository(cwd);
  base ||= getCommit(cwd);
  head ||= `${base}^1`;

  const url = `https://api.github.com/repos/${repository}/compare/${head}...${base}`;
  const { error, body } = await curl(url, { json: true });

  if (error) {
    console.warn("Failed to list changed files:", error);
    return;
  }

  const { files } = body;
  return files.filter(({ status }) => !/removed|unchanged/i.test(status)).map(({ filename }) => filename);
}

/**
 * @param {string} filename
 * @returns {boolean}
 */
export function isDocumentation(filename) {
  if (/^(docs|bench|examples|misctools|\.vscode)/.test(filename)) {
    return true;
  }

  if (!/^(src|test|vendor)/.test(filename) && /\.(md|txt)$/.test(filename)) {
    return true;
  }

  return false;
}

/**
 * @returns {string | undefined}
 */
export function getBuildId() {
  if (isBuildkite) {
    return getEnv("BUILDKITE_BUILD_ID");
  }

  if (isGithubAction) {
    return getEnv("GITHUB_RUN_ID");
  }
}

/**
 * @returns {number | undefined}
 */
export function getBuildNumber() {
  if (isBuildkite) {
    return parseInt(getEnv("BUILDKITE_BUILD_NUMBER"));
  }

  if (isGithubAction) {
    return parseInt(getEnv("GITHUB_RUN_ID"));
  }
}

/**
 * @returns {URL | undefined}
 */
export function getBuildUrl() {
  if (isBuildkite) {
    const buildUrl = getEnv("BUILDKITE_BUILD_URL");
    const jobId = getEnv("BUILDKITE_JOB_ID");
    return new URL(`#${jobId}`, buildUrl);
  }

  if (isGithubAction) {
    const baseUrl = getEnv("GITHUB_SERVER_URL", false) || "https://github.com";
    const repository = getEnv("GITHUB_REPOSITORY");
    const runId = getEnv("GITHUB_RUN_ID");
    return new URL(`${repository}/actions/runs/${runId}`, baseUrl);
  }
}

/**
 * @returns {string | undefined}
 */
export function getBuildLabel() {
  if (isBuildkite) {
    const label = getEnv("BUILDKITE_GROUP_LABEL", false) || getEnv("BUILDKITE_LABEL", false);
    if (label) {
      return label;
    }
  }

  if (isGithubAction) {
    const label = getEnv("GITHUB_WORKFLOW", false);
    if (label) {
      return label;
    }
  }
}

/**
 * @typedef {object} BuildArtifact
 * @property {string} [job]
 * @property {string} filename
 * @property {string} url
 */

/**
 * @returns {Promise<BuildArtifact[] | undefined>}
 */
export async function getBuildArtifacts() {
  const buildId = await getBuildkiteBuildNumber();
  if (buildId) {
    return getBuildkiteArtifacts(buildId);
  }
}

/**
 * @returns {Promise<number | undefined>}
 */
export async function getBuildkiteBuildNumber() {
  if (isBuildkite) {
    const number = parseInt(getEnv("BUILDKITE_BUILD_NUMBER", false));
    if (!isNaN(number)) {
      return number;
    }
  }

  const repository = getRepository();
  const commit = getCommit();
  if (!repository || !commit) {
    return;
  }

  const { status, error, body } = await curl(`https://api.github.com/repos/${repository}/commits/${commit}/statuses`, {
    json: true,
  });
  if (status === 404) {
    return;
  }
  if (error) {
    throw error;
  }

  for (const { target_url: url } of body) {
    const { hostname, pathname } = new URL(url);
    if (hostname === "buildkite.com") {
      const buildId = parseInt(pathname.split("/").pop());
      if (!isNaN(buildId)) {
        return buildId;
      }
    }
  }
}

/**
 * @param {string} buildId
 * @returns {Promise<BuildArtifact[]>}
 */
export async function getBuildkiteArtifacts(buildId) {
  const orgId = getEnv("BUILDKITE_ORGANIZATION_SLUG", false) || "bun";
  const pipelineId = getEnv("BUILDKITE_PIPELINE_SLUG", false) || "bun";
  const { jobs } = await curlSafe(`https://buildkite.com/${orgId}/${pipelineId}/builds/${buildId}.json`, {
    json: true,
  });

  const artifacts = await Promise.all(
    jobs.map(async ({ id: jobId, step_key: jobKey }) => {
      const artifacts = await curlSafe(
        `https://buildkite.com/organizations/${orgId}/pipelines/${pipelineId}/builds/${buildId}/jobs/${jobId}/artifacts`,
        { json: true },
      );

      return artifacts.map(({ path, url }) => {
        return {
          job: jobKey,
          filename: path,
          url: new URL(url, "https://buildkite.com/").toString(),
        };
      });
    }),
  );

  return artifacts.flat();
}

/**
 * @param {string} [filename]
 * @param {number} [line]
 * @returns {URL | undefined}
 */
export function getFileUrl(filename, line) {
  let cwd;
  if (filename?.startsWith("vendor")) {
    const parentPath = resolve(dirname(filename));
    const { error, stdout } = spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: parentPath });
    if (error) {
      return;
    }
    cwd = stdout.trim();
  }

  const baseUrl = getRepositoryUrl(cwd);
  if (!filename) {
    return baseUrl;
  }

  const filePath = (cwd ? relative(cwd, filename) : filename).replace(/\\/g, "/");
  const pullRequest = getPullRequest();

  if (pullRequest) {
    const fileMd5 = createHash("sha256").update(filePath).digest("hex");
    const url = new URL(`pull/${pullRequest}/files#diff-${fileMd5}`, `${baseUrl}/`);
    if (typeof line !== "undefined") {
      return new URL(`R${line}`, url);
    }
    return url;
  }

  const commit = getCommit(cwd);
  const url = new URL(`blob/${commit}/${filePath}`, `${baseUrl}/`).toString();
  if (typeof line !== "undefined") {
    return new URL(`#L${line}`, url);
  }
  return url;
}

/**
 * @typedef {object} BuildkiteBuild
 * @property {string} id
 * @property {string} commit_id
 * @property {string} branch_name
 */

/**
 * @returns {Promise<BuildkiteBuild | undefined>}
 */
export async function getLastSuccessfulBuild() {
  if (isBuildkite) {
    let depth = 0;
    let url = getBuildUrl();
    if (url) {
      url.hash = "";
    }

    while (url) {
      const { error, body } = await curl(`${url}.json`, { json: true });
      if (error) {
        return;
      }

      const { state, prev_branch_build: previousBuild, steps } = body;
      if (depth++) {
        if (state === "failed" || state === "passed" || state === "canceled") {
          const buildSteps = steps.filter(({ label }) => label.endsWith("build-bun"));
          if (buildSteps.length) {
            if (buildSteps.every(({ outcome }) => outcome === "passed")) {
              return body;
            }
            return;
          }
        }
      }

      if (!previousBuild) {
        return;
      }

      url = new URL(previousBuild["url"], url);
    }
  }
}

/**
 * @param {string} string
 * @returns {string}
 */
export function stripAnsi(string) {
  return string.replace(/\u001b\[\d+m/g, "");
}

/**
 * @param {string} string
 * @returns {string}
 */
export function escapeGitHubAction(string) {
  return string.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * @param {string} string
 * @returns {string}
 */
export function unescapeGitHubAction(string) {
  return string.replace(/%25/g, "%").replace(/%0D/g, "\r").replace(/%0A/g, "\n");
}

/**
 * @param {string} string
 * @returns {string}
 */
export function escapeHtml(string) {
  return string
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .replace(/`/g, "&#96;");
}

/**
 * @param {string} string
 * @returns {string}
 */
export function escapeCodeBlock(string) {
  return string.replace(/`/g, "\\`");
}

/**
 * @returns {string}
 */
export function tmpdir() {
  if (isWindows) {
    for (const key of ["TMPDIR", "TEMP", "TEMPDIR", "TMP", "RUNNER_TEMP"]) {
      const tmpdir = getEnv(key, false);
      if (!tmpdir || /cygwin|cygdrive/i.test(tmpdir) || !/^[a-z]/i.test(tmpdir)) {
        continue;
      }
      return normalizeWindows(tmpdir);
    }

    const appData = process.env["LOCALAPPDATA"];
    if (appData) {
      const appDataTemp = join(appData, "Temp");
      if (existsSync(appDataTemp)) {
        return appDataTemp;
      }
    }
  }

  if (isMacOS || isLinux) {
    if (existsSync("/tmp")) {
      return "/tmp";
    }
  }

  return nodeTmpdir();
}

/**
 * @param {string} string
 * @returns {string}
 */
function escapePowershell(string) {
  return string.replace(/'/g, "''").replace(/`/g, "``");
}

/**
 * @param {string} filename
 * @param {string} [output]
 * @returns {Promise<string>}
 */
export async function unzip(filename, output) {
  const destination = output || mkdtempSync(join(tmpdir(), "unzip-"));
  if (isWindows) {
    const command = `Expand-Archive -Force -LiteralPath "${escapePowershell(filename)}" -DestinationPath "${escapePowershell(destination)}"`;
    await spawnSafe(["powershell", "-Command", command]);
  } else {
    await spawnSafe(["unzip", "-o", filename, "-d", destination]);
  }
  return destination;
}

/**
 * @param {string} string
 * @returns {"darwin" | "linux" | "windows"}
 */
export function parseOs(string) {
  if (/darwin|apple|mac/i.test(string)) {
    return "darwin";
  }
  if (/linux/i.test(string)) {
    return "linux";
  }
  if (/win/i.test(string)) {
    return "windows";
  }
  throw new Error(`Unsupported operating system: ${string}`);
}

/**
 * @returns {"darwin" | "linux" | "windows"}
 */
export function getOs() {
  return parseOs(process.platform);
}

/**
 * @param {string} string
 * @returns {"x64" | "aarch64"}
 */
export function parseArch(string) {
  if (/x64|amd64|x86_64/i.test(string)) {
    return "x64";
  }
  if (/arm64|aarch64/i.test(string)) {
    return "aarch64";
  }
  throw new Error(`Unsupported architecture: ${string}`);
}

/**
 * @returns {"x64" | "aarch64"}
 */
export function getArch() {
  return parseArch(process.arch);
}

/**
 * @returns {"musl" | "gnu" | undefined}
 */
export function getAbi() {
  if (isLinux) {
    const arch = getArch() === "x64" ? "x86_64" : "aarch64";
    const muslLibPath = `/lib/ld-musl-${arch}.so.1`;
    if (existsSync(muslLibPath)) {
      return "musl";
    }

    const gnuLibPath = `/lib/ld-linux-${arch}.so.2`;
    if (existsSync(gnuLibPath)) {
      return "gnu";
    }
  }
}

/**
 * @typedef {object} Target
 * @property {"darwin" | "linux" | "windows"} os
 * @property {"x64" | "aarch64"} arch
 * @property {"musl"} [abi]
 * @property {boolean} [baseline]
 * @property {boolean} profile
 * @property {string} label
 */

/**
 * @param {string} string
 * @returns {Target}
 */
export function parseTarget(string) {
  const os = parseOs(string);
  const arch = parseArch(string);
  const abi = os === "linux" && string.includes("-musl") ? "musl" : undefined;
  const baseline = arch === "x64" ? string.includes("-baseline") : undefined;
  const profile = string.includes("-profile");

  let label = `${os}-${arch}`;
  if (abi) {
    label += `-${abi}`;
  }
  if (baseline) {
    label += "-baseline";
  }
  if (profile) {
    label += "-profile";
  }

  return { label, os, arch, abi, baseline, profile };
}

/**
 * @param {string} target
 * @param {string} [release]
 * @returns {Promise<URL>}
 */
export async function getTargetDownloadUrl(target, release) {
  const { label, os, arch, abi, baseline } = parseTarget(target);
  const baseUrl = "https://pub-5e11e972747a44bf9aaf9394f185a982.r2.dev/releases/";
  const filename = `bun-${label}.zip`;

  const exists = async url => {
    const { status } = await curl(url, { method: "HEAD" });
    return status !== 404;
  };

  if (!release || /^(stable|latest|canary)$/i.test(release)) {
    const tag = release === "canary" ? "canary" : "latest";
    const url = new URL(`${tag}/${filename}`, baseUrl);
    if (await exists(url)) {
      return url;
    }
  }

  if (/^(bun-v|v)?(\d+\.\d+\.\d+)$/i.test(release)) {
    const [, major, minor, patch] = /(\d+)\.(\d+)\.(\d+)/i.exec(release);
    const url = new URL(`bun-v${major}.${minor}.${patch}/${filename}`, baseUrl);
    if (await exists(url)) {
      return url;
    }
  }

  if (/^https?:\/\//i.test(release) && (await exists(release))) {
    return new URL(release);
  }

  if (release.length === 40 && /^[0-9a-f]{40}$/i.test(release)) {
    const releaseUrl = new URL(`${release}/${filename}`, baseUrl);
    if (await exists(releaseUrl)) {
      return releaseUrl;
    }

    const canaryUrl = new URL(`${release}-canary/${filename}`, baseUrl);
    if (await exists(canaryUrl)) {
      return canaryUrl;
    }

    const statusUrl = new URL(`https://api.github.com/repos/oven-sh/bun/commits/${release}/status`).toString();
    const { error, body } = await curl(statusUrl, { json: true });
    if (error) {
      throw new Error(`Failed to fetch commit status: ${release}`, { cause: error });
    }

    const { statuses } = body;
    const buildUrls = new Set();
    for (const { target_url: url } of statuses) {
      const { hostname, origin, pathname } = new URL(url);
      if (hostname === "buildkite.com") {
        buildUrls.add(`${origin}${pathname}.json`);
      }
    }

    const buildkiteUrl = new URL("https://buildkite.com/");
    for (const url of buildUrls) {
      const { status, error, body } = await curl(url, { json: true });
      if (status === 404) {
        continue;
      }
      if (error) {
        throw new Error(`Failed to fetch build: ${url}`, { cause: error });
      }

      const { jobs } = body;
      const job = jobs.find(
        ({ step_key: key }) =>
          key &&
          key.includes("build-bun") &&
          key.includes(os) &&
          key.includes(arch) &&
          (!baseline || key.includes("baseline")) &&
          (!abi || key.includes(abi)),
      );
      if (!job) {
        continue;
      }

      const { base_path: jobPath } = job;
      const artifactsUrl = new URL(`${jobPath}/artifacts`, buildkiteUrl);
      {
        const { error, body } = await curl(artifactsUrl, { json: true });
        if (error) {
          continue;
        }

        for (const { url, file_name: name } of body) {
          if (name === filename) {
            return new URL(url, artifactsUrl);
          }
        }
      }
    }
  }

  throw new Error(`Failed to find release: ${release}`);
}

/**
 * @param {string} target
 * @param {string} [release]
 * @returns {Promise<string>}
 */
export async function downloadTarget(target, release) {
  const url = await getTargetDownloadUrl(target, release);
  const { error, body } = await curl(url, { arrayBuffer: true });
  if (error) {
    throw new Error(`Failed to download target: ${target} at ${release}`, { cause: error });
  }

  const tmpPath = mkdtempSync(join(tmpdir(), "bun-download-"));
  const zipPath = join(tmpPath, "bun.zip");

  writeFileSync(zipPath, new Uint8Array(body));
  const unzipPath = await unzip(zipPath, tmpPath);

  for (const entry of readdirSync(unzipPath, { recursive: true, encoding: "utf-8" })) {
    const exePath = join(unzipPath, entry);
    if (/bun(?:\.exe)?$/i.test(entry)) {
      return exePath;
    }
  }

  throw new Error(`Failed to find bun executable: ${unzipPath}`);
}

/**
 * @returns {string | undefined}
 */
export function getTailscaleIp() {
  let tailscale = "tailscale";
  if (isMacOS) {
    const tailscaleApp = "/Applications/Tailscale.app/Contents/MacOS/tailscale";
    if (existsSync(tailscaleApp)) {
      tailscale = tailscaleApp;
    }
  }

  const { error, stdout } = spawnSync([tailscale, "ip", "--1"]);
  if (!error) {
    return stdout.trim();
  }
}

/**
 * @returns {string | undefined}
 */
export function getPublicIp() {
  for (const url of ["https://checkip.amazonaws.com", "https://ipinfo.io/ip"]) {
    const { error, stdout } = spawnSync(["curl", url]);
    if (!error) {
      return stdout.trim();
    }
  }
}

/**
 * @returns {string}
 */
export function getHostname() {
  if (isBuildkite) {
    const agent = getEnv("BUILDKITE_AGENT_NAME", false);
    if (agent) {
      return agent;
    }
  }

  if (isGithubAction) {
    const runner = getEnv("RUNNER_NAME", false);
    if (runner) {
      return runner;
    }
  }

  return hostname();
}

/**
 * @returns {string}
 */
export function getUsername() {
  const { username } = userInfo();
  return username;
}

/**
 * @returns {string}
 */
export function getDistro() {
  if (isMacOS) {
    return "macOS";
  }

  if (isLinux) {
    const releasePath = "/etc/os-release";
    if (existsSync(releasePath)) {
      const releaseFile = readFile(releasePath, { cache: true });
      const match = releaseFile.match(/ID=\"(.*)\"/);
      if (match) {
        return match[1];
      }
    }

    const { error, stdout } = spawnSync(["lsb_release", "-is"]);
    if (!error) {
      return stdout.trim();
    }

    return "Linux";
  }

  if (isWindows) {
    const { error, stdout } = spawnSync(["cmd", "/c", "ver"]);
    if (!error) {
      return stdout.trim();
    }

    return "Windows";
  }

  return `${process.platform} ${process.arch}`;
}

/**
 * @returns {string | undefined}
 */
export function getDistroRelease() {
  if (isMacOS) {
    const { error, stdout } = spawnSync(["sw_vers", "-productVersion"]);
    if (!error) {
      return stdout.trim();
    }
  }

  if (isLinux) {
    const releasePath = "/etc/os-release";
    if (existsSync(releasePath)) {
      const releaseFile = readFile(releasePath, { cache: true });
      const match = releaseFile.match(/VERSION_ID=\"(.*)\"/);
      if (match) {
        return match[1];
      }
    }

    const { error, stdout } = spawnSync(["lsb_release", "-rs"]);
    if (!error) {
      return stdout.trim();
    }
  }

  if (isWindows) {
    const { error, stdout } = spawnSync(["cmd", "/c", "ver"]);
    if (!error) {
      return stdout.trim();
    }
  }
}

/**
 * @returns {Promise<number | undefined>}
 */
export async function getCanaryRevision() {
  const repository = getRepository() || "oven-sh/bun";
  const { error: releaseError, body: release } = await curl(
    new URL(`repos/${repository}/releases/latest`, getGithubApiUrl()),
    { json: true },
  );
  if (releaseError) {
    return 1;
  }

  const commit = getCommit();
  const { tag_name: latest } = release;
  const { error: compareError, body: compare } = await curl(
    new URL(`repos/${repository}/compare/${latest}...${commit}`, getGithubApiUrl()),
    { json: true },
  );
  if (compareError) {
    return 1;
  }

  const { ahead_by: revision } = compare;
  if (typeof revision === "number") {
    return revision;
  }

  return 1;
}

/**
 * @returns {URL}
 */
export function getGithubApiUrl() {
  return new URL(getEnv("GITHUB_API_URL", false) || "https://api.github.com");
}

/**
 * @returns {URL}
 */
export function getGithubUrl() {
  return new URL(getEnv("GITHUB_SERVER_URL", false) || "https://github.com");
}

/**
 * @param {string} title
 * @param {function} [fn]
 */
export function startGroup(title, fn) {
  if (isGithubAction) {
    console.log(`::group::${stripAnsi(title)}`);
  } else if (isBuildkite) {
    console.log(`--- ${title}`);
  } else {
    console.group(title);
  }

  if (typeof fn === "function") {
    let result;
    try {
      result = fn();
    } finally {
      if (result instanceof Promise) {
        return result.finally(() => endGroup());
      } else {
        endGroup();
      }
    }
  }
}

export function endGroup() {
  if (isGithubAction) {
    console.log("::endgroup::");
  } else {
    console.groupEnd();
  }
}

export function printEnvironment() {
  startGroup("Machine", () => {
    console.log("Operating System:", getOs());
    console.log("Architecture:", getArch());
    if (isLinux) {
      console.log("ABI:", getAbi());
    }
    console.log("Distro:", getDistro());
    console.log("Release:", getDistroRelease());
    console.log("Hostname:", getHostname());
    if (isCI) {
      console.log("Tailscale IP:", getTailscaleIp());
      console.log("Public IP:", getPublicIp());
    }
    console.log("Username:", getUsername());
    console.log("Working Directory:", process.cwd());
    console.log("Temporary Directory:", tmpdir());
  });

  if (isCI) {
    startGroup("Environment", () => {
      for (const [key, value] of Object.entries(process.env)) {
        console.log(`${key}:`, value);
      }
    });
  }

  startGroup("Repository", () => {
    console.log("Commit:", getCommit());
    console.log("Message:", getCommitMessage());
    console.log("Branch:", getBranch());
    console.log("Main Branch:", getMainBranch());
    console.log("Is Fork:", isFork());
    console.log("Is Merge Queue:", isMergeQueue());
    console.log("Is Main Branch:", isMainBranch());
    console.log("Is Pull Request:", isPullRequest());
    if (isPullRequest()) {
      console.log("Pull Request:", getPullRequest());
      console.log("Target Branch:", getTargetBranch());
    }
  });

  if (isCI) {
    startGroup("CI", () => {
      console.log("Build ID:", getBuildId());
      console.log("Build Label:", getBuildLabel());
      console.log("Build URL:", `${getBuildUrl()}`);
    });
  }
}
