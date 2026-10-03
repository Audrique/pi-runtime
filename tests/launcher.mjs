import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

function requiredPath(name) {
  const value = process.env[name];
  assert.ok(value && isAbsolute(value), `${name} must be an absolute path`);
  return value;
}

const launcher = requiredPath("PI_TEST_LAUNCHER");
const subagents = requiredPath("PI_SUBAGENTS_EXTENSION");
const permissions = requiredPath("PI_PERMISSIONS_EXTENSION");
const config = requiredPath("PI_EXPECT_CONFIG");
const web = requiredPath("PI_EXPECT_WEB");
const herdrNotifications = requiredPath("PI_EXPECT_HERDR_NOTIFICATIONS");
const forwarded = ["--model", "test/model", "a prompt with spaces", "", "literal * and $HOME"];

for (const child of [false, true]) {
  const env = {
    ...process.env,
    PI_ORCHESTRATOR_CONFIG: "/wrong/config",
    PI_CODING_AGENT_DIR: "/wrong/agent",
    PI_GUARDED_EXECUTABLE: "/wrong/executable",
    PI_WEB_EXTENSION: "/wrong/web",
    PI_AGENT_ROUTER_PARENT_SESSION_ID: "legacy-parent-must-be-removed",
    PATH: "",
  };
  if (child) env.PI_DOTFILES_SUBAGENT = "1";
  else delete env.PI_DOTFILES_SUBAGENT;

  const result = spawnSync(launcher, forwarded, { env, encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${child ? "child" : "root"} launcher failed: ${result.stderr}`);
  const captured = JSON.parse(result.stdout);
  assert.deepEqual(captured.args, [
    "--extension", join(subagents, child ? "orchestrator/index.ts" : "index.ts"),
    "--extension", join(permissions, "index.ts"),
    "--extension", join(permissions, "ai-authorizer/index.ts"),
    "--extension", herdrNotifications,
    ...forwarded,
  ], "exactly four mandatory extensions must precede unmodified user arguments");
  assert.equal(captured.config, config);
  assert.equal(captured.agentDir, "/test/pi agent");
  assert.equal(captured.guarded, launcher);
  assert.equal(captured.web, web);
  assert.equal(captured.legacyParent, undefined, "legacy parent routing must be unset");
  for (const executable of ["bash", "mv"]) {
    const utility = spawnSync(executable, ["--version"], { env: { PATH: captured.path }, encoding: "utf8", timeout: 5000 });
    assert.ifError(utility.error);
    assert.equal(utility.status, 0, `${executable} must be provided without relying on the caller's PATH`);
  }
}
console.log("Pi launcher check passed: root/child extensions, argument forwarding, and environment contract.");
