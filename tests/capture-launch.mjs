console.log(JSON.stringify({
  args: process.argv.slice(2),
  config: process.env.PI_ORCHESTRATOR_CONFIG,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  guarded: process.env.PI_GUARDED_EXECUTABLE,
  web: process.env.PI_WEB_EXTENSION,
  legacyParent: process.env.PI_AGENT_ROUTER_PARENT_SESSION_ID,
  path: process.env.PATH,
}));
