{
  lib,
  writeShellScriptBin,
  bash,
}:
{
  pi,
  herdr,
  subagents,
  permissions,
  plugins,
  configFile,
  agentDir ? null,
}:
writeShellScriptBin "pi" ''
  export PI_ORCHESTRATOR_CONFIG=${lib.escapeShellArg "${configFile}"}
  ${lib.optionalString (agentDir != null) "export PI_CODING_AGENT_DIR=${lib.escapeShellArg agentDir}"}
  export PI_GUARDED_EXECUTABLE="$0"
  export PI_WEB_EXTENSION=${plugins.web}/index.ts
  unset PI_AGENT_ROUTER_PARENT_SESSION_ID
  export PATH=${
    lib.makeBinPath [
      herdr
      bash
    ]
  }:"$PATH"
  if [ "''${PI_DOTFILES_SUBAGENT:-}" = 1 ]; then
    orchestrator=${subagents}/${subagents.extensionPath}/pi-extension/subagents/orchestrator/index.ts
  else
    orchestrator=${subagents}/${subagents.extensionPath}/pi-extension/subagents/index.ts
  fi
  exec ${lib.getExe pi} \
    --extension "$orchestrator" \
    --extension ${permissions}/${permissions.extensionPath}/src/index.ts \
    --extension ${permissions}/${permissions.extensionPath}/src/ai-authorizer/index.ts \
    --extension ${../extensions}/herdr-notifications.ts "$@"
''
