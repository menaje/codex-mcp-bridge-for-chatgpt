import type { ModelPolicyError } from "./modelPolicy.js";
import {
  guidance,
  modelsAction,
  settingsAction,
  statusAction,
  type ModelNextAction
} from "./nextActions.js";

/** Recovery records are typed, non-mutating suggestions for the current contract. */
export function modelPolicyRecoveryActions(error: ModelPolicyError): ModelNextAction[] {
  if (error.recovery === "omit-selection") {
    return [guidance("Omit selection and retry the same codex_task with a new requestId; the saved fixed selection will be applied.")];
  }
  if (error.recovery === "fresh-context") {
    return [
      statusAction({}, "Inspect the retained work before deciding whether to replace its context."),
      guidance("If fresh context is authorized, retry codex_task for the same existing Agent with agent.context='fresh', an exact current project selector, and a new requestId. The current thread transcript is not copied into fresh context.")
    ];
  }
  return [
    modelsAction(true, "Refresh the model catalog for the current saved policy."),
    guidance("Use selectionMode from that response: fixed mode omits selection; automatic mode uses an exact returned model and reasoning effort within the user's delegation. Retry codex_task with a new requestId only after resolving this error."),
    settingsAction("Open settings only if the user chooses to review or change the saved policy. Do not automatically change Priority, permissions, or other saved settings.")
  ];
}
