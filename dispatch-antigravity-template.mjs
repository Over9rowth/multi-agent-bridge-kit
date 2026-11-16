#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const STATE_FILE = path.join(ROOT, ".agent-bridge-state.json");
const MODELS = {
  high: "MODEL_PLACEHOLDER_M318",     // Gemini 3.8 Flash (High)
  medium: "MODEL_PLACEHOLDER_M319",   // Gemini 3.8 Flash (Medium)
  low: "MODEL_PLACEHOLDER_M320",      // Gemini 3.8 Flash (Low)
  argon: "MODEL_PLACEHOLDER_M417",    // Gemini 4 Argon (High)
  sonnet: "MODEL_PLACEHOLDER_M405",   // Claude Sonnet 5.5 (High)
  opus: "MODEL_PLACEHOLDER_M402",     // Claude Opus 5.5 (High)
  gpt: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM", // GPT-OSS 120B (Medium)
};

function discover() {
  const ps = `$p = Get-CimInstance Win32_Process -Filter 'Name = "language_server.exe"' | Select-Object -First 1; if (-not $p) { throw 'No language_server.exe' }; $c = [regex]::Match($p.CommandLine, '--csrf_token\\s+(\\S+)').Groups[1].Value; $pts = Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen | Select-Object -ExpandProperty LocalPort; @{ pid = $p.ProcessId; csrf = $c; ports = @($pts) } | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim());
}

function rpc(port, csrf, method, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-codeium-csrf-token": csrf,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(d || "{}")) : reject(new Error(`${method} ${res.statusCode}: ${d}`))));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
function makeConfig(modelId) {
  const b = (s) => s.split(",").map((name) => ({ name, builtin: true }));
  return {
    plannerConfig: {
      declarativeMixinConfig: {
        promptSections: "identity,terminal_sandbox,artifacts,conversation_transcript,guidelines,communication_style,slash_commands,messaging,mcp_servers,subagents,user_rules,skills,featured_plugins,user_information,subagent_reminder".split(",").map((builtinName) => ({ builtinName })),
        tools: b("read_file,run_command,list_plugin_accounts,manage_task,send_message,schedule,invoke_subagent,define_subagent,manage_subagents,write_file,edit_file,search_web,search_marketplace,ask_question"),
        preInvocationHooks: b("message_delivery,context_summary"),
        postInvocationHooks: b("command_assessor,message_continue_check,terminal_step_check,max_generator_invocations_check,empty_output_continuation_check,force_invocation,no_tool_call_check"),
        preToolHooks: b("battle_mode_tool_args,command_assessor,timeout_long_running_search_command,auto_run_safety_gate"),
        postToolHooks: b("command_assessor"),
        stopHooks: b("goal_stop,idle_subagent_guard"),
        toolDecorators: b("output_truncation"),
        forceDisableFundamentalComponents: true,
      },
      customizationDiscoveryConfig: {
        skills: { builtinSkillNames: "agy-customizations,antigravity_guide,automation,generative_ui,migrate-workflows,plugin,ui-plugin-navigation".split(",") },
        agents: { builtinAgentNames: "self,research,browser,teamwork,DeepCoder,DeepInvestigator,image-generator".split(",") },
      },
      toolConfig: { runCommand: { autoCommandConfig: { autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER" } }, notifyUser: {} },
      planModel: modelId,
      useAiCredits: true,
      supportsLatexRendering: true,
    },
    executorConfig: { useCoreDirect: true },
    conversationHistoryConfig: {},
  };
}

async function main() {
  const argv = process.argv.slice(2);
  let model = "high", reuse = false, statusOnly = false, timeout = 600, prompt = "", file = "", cascadeId = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--status") statusOnly = true;
    else if (argv[i] === "--reuse") reuse = true;
    else if (argv[i] === "--model") model = argv[++i];
    else if (argv[i] === "--prompt") prompt = argv[++i];
    else if (argv[i] === "--file") file = argv[++i];
    else if (argv[i] === "--cascade") cascadeId = argv[++i];
    else if (argv[i] === "--timeout") timeout = Number(argv[++i]);
  }

  const { pid, csrf, ports } = discover();
  let port;
  for (const p of ports) {
    try { await rpc(p, csrf, "GetCascadeModelConfigData", {}); port = p; break; } catch {}
  }
  if (!port) throw new Error("No working RPC port found");
  const modelId = MODELS[model] || model || MODELS.high;

  if (statusOnly) {
    const m = await rpc(port, csrf, "GetCascadeModelConfigData", {});
    console.log(JSON.stringify({ connected: true, pid, port, modelId, flashModels: (m.clientModelConfigs || []).filter((x) => /Flash/i.test(x.label)).map((x) => ({ label: x.label, id: x.modelOrAlias?.model })) }, null, 2));
    return;
  }

  const text = file ? fs.readFileSync(path.resolve(ROOT, file), "utf8") : prompt;
  if (!text.trim()) throw new Error("Missing --prompt or --file");

  if (!cascadeId && reuse && fs.existsSync(STATE_FILE)) {
    cascadeId = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).lastCascadeId || "";
  }
  const meta = { ideName: "antigravity", ideVersion: "2.28.2", extensionName: "antigravity" };
  if (!cascadeId) {
    const r = await rpc(port, csrf, "StartCascade", {
      metadata: meta,
      source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
      workspaceUris: [pathToFileURL(ROOT).href],
      trajectoryType: "CORTEX_TRAJECTORY_TYPE_CASCADE",
    });
    cascadeId = r.cascadeId;
    console.log(`[Flash Bridge] New session: ${cascadeId}`);
  } else {
    console.log(`[Flash Bridge] Reuse session: ${cascadeId}`);
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastCascadeId: cascadeId, modelId }, null, 2));

  const before = await rpc(port, csrf, "GetAllCascadeTrajectories", {});
  const baseSteps = before.trajectorySummaries?.[cascadeId]?.stepCount || 0;

  await rpc(port, csrf, "SendUserCascadeMessage", { metadata: meta, cascadeId, items: [{ text }], cascadeConfig: makeConfig(modelId) });

  const t0 = Date.now();
  let last = baseSteps;
  let idleTicks = 0;
  let lastIdleStepCount = -1;
  while ((Date.now() - t0) / 1000 < timeout) {
    await new Promise((r) => setTimeout(r, 1500));
    const tr = await rpc(port, csrf, "GetAllCascadeTrajectories", {});
    const sum = tr.trajectorySummaries?.[cascadeId];
    if (!sum) continue;
    if ((sum.stepCount || 0) > last) {
      const sr = await rpc(port, csrf, "GetCascadeTrajectorySteps", { cascadeId, startIndex: last, endIndex: sum.stepCount });
      for (let idx = 0; idx < (sr.steps || []).length; idx++) {
        const s = sr.steps[idx];
        const stepIndex = last + idx;
        const st = (s.type || "").replace("CORTEX_STEP_TYPE_", "");
        if (st && st !== "EPHEMERAL_MESSAGE") console.log(`  -> [Step ${stepIndex}] ${st} (${s.status || ""})`);
        if (s.status === "CORTEX_STEP_STATUS_WAITING" && s.runCommand) {
          const cmd = s.runCommand.proposedCommandLine || s.runCommand.commandLine || "";
          console.log(`  -> [Auto-Approve Command] ${cmd}`);
          await rpc(port, csrf, "HandleCascadeUserInteraction", {
            cascadeId,
            interaction: {
              trajectoryId: sum.trajectoryId,
              stepIndex,
              runCommand: { confirm: true, proposedCommandLine: cmd, submittedCommandLine: cmd },
            },
          }).catch(() => {});
        }
      }
      last = sum.stepCount;
    }
    if (sum.status === "CASCADE_RUN_STATUS_IDLE" && (sum.stepCount || 0) > baseSteps) {
      const sr = await rpc(port, csrf, "GetCascadeTrajectorySteps", { cascadeId, startIndex: baseSteps, endIndex: sum.stepCount });
      const steps = sr.steps || [];
      const hasPending = steps.some((s) => ["CORTEX_STEP_STATUS_RUNNING", "CORTEX_STEP_STATUS_GENERATING", "CORTEX_STEP_STATUS_WAITING"].includes(s.status));
      const nonEphemeral = steps.filter((s) => s.type !== "CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE");
      const lastStep = nonEphemeral[nonEphemeral.length - 1];
      const isPlannerResponse = lastStep && lastStep.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE";

      if (!hasPending && isPlannerResponse) {
        if (lastIdleStepCount === sum.stepCount) {
          idleTicks++;
        } else {
          lastIdleStepCount = sum.stepCount;
          idleTicks = 1;
        }

        if (idleTicks >= 2) {
          const replies = steps.filter((s) => s.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" && s.plannerResponse?.response).map((s) => s.plannerResponse.response);
          console.log("\n=== [Gemini 3.8 Flash Reply] ===\n" + (replies[replies.length - 1] || "(Completed)"));
          return;
        }
      } else {
        idleTicks = 0;
        lastIdleStepCount = -1;
      }
    } else {
      idleTicks = 0;
      lastIdleStepCount = -1;
    }
  }
  throw new Error("Timeout waiting for Flash worker");
}

main().catch((e) => { console.error("[Flash Bridge Error]", e.message || e); process.exit(1); });
