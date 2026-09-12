/** ChatGPT's sandbox omits allow-modals: native confirm() cannot authorize a
 * stop there. Keep the confirmation in the card and bound to the displayed read. */
export const DASHBOARD_STOP_CONFIRMATION_SCRIPT = String.raw`
function confirmControlStop(detail,args){
 if(controlBusy||controlDetail!==detail)return;
 controlBody.querySelector("#work-stop-confirmation")?.remove();
 const panel=node("section","interaction"),target=[detail.projectName,detail.activityTitle,detail.agentName,args.processId].filter(Boolean).join(" · ");
 panel.id="work-stop-confirmation";panel.setAttribute("role","group");panel.setAttribute("aria-label",t["activity.forceConfirmTitle"]);
 panel.append(node("strong","",t["activity.forceConfirmTitle"]),node("p","message",target),node("p","message",t["activity.partialChanges"]));
 if(args.kind==="job"&&(detail.affectedJobIds||[]).length>1)panel.appendChild(node("p","message",t["activity.forceConfirm"]));
 const actions=node("div","actions"),cancel=actionButton(t["common.cancel"],()=>{panel.remove();scheduleSizeChanged(true)});
 actions.append(cancel,actionButton(t["activity.forceStop"],()=>{if(controlDetail!==detail||!panel.isConnected||controlBusy)return;void controlAction("codex_ui_stop",args)}));
 panel.appendChild(actions);controlBody.appendChild(panel);cancel.focus();panel.scrollIntoView({block:"nearest"});scheduleSizeChanged(true);
}
`;

export const DASHBOARD_STOP_BUTTONS = String.raw`
 if(detail.canStop)controlBody.appendChild(actionButton(t["activity.forceStop"],()=>confirmControlStop(detail,{kind:"job",jobId:detail.jobId,expectedJobVersion:detail.jobVersion,acknowledgeAffectedJobIds:detail.affectedJobIds})));
 for(const process of detail.backgroundProcesses||[]){const row=node("div","actions");row.append(node("span","meta",process.processId),actionButton(t["activity.forceStop"],()=>confirmControlStop(detail,{kind:"process",agentId:detail.agentId,expectedAgentVersion:detail.agentVersion,processId:process.processId})));controlBody.appendChild(row)}
`;

// Exact compatibility repair for #71 cards already stored in conversations.
// Keep snapshot bytes, resource identities, metadata and all domain calls intact.
const LEGACY_STOP_BUTTONS = String.raw`
 if(detail.canStop)controlBody.appendChild(actionButton(t["activity.forceStop"],()=>{const target=[detail.projectName,detail.activityTitle,detail.agentName].filter(Boolean).join(" · ");if(confirm(target+"\n\n"+t["activity.forceConfirmTitle"]+"\n"+t["activity.partialChanges"]+((detail.affectedJobIds||[]).length>1?"\n"+t["activity.forceConfirm"]:"")))void controlAction("codex_ui_stop",{kind:"job",jobId:detail.jobId,expectedJobVersion:detail.jobVersion,acknowledgeAffectedJobIds:detail.affectedJobIds})}));
 for(const process of detail.backgroundProcesses||[]){const row=node("div","actions");row.append(node("span","meta",process.processId),actionButton(t["activity.forceStop"],()=>{if(confirm(detail.agentName+" · "+process.processId+"\n\n"+t["activity.partialChanges"]))void controlAction("codex_ui_stop",{kind:"process",agentId:detail.agentId,expectedAgentVersion:detail.agentVersion,processId:process.processId})}));controlBody.appendChild(row)}
`;

export function repairRetainedDashboardStops(html: string): string {
  if (!html.includes(LEGACY_STOP_BUTTONS) || !html.includes("function renderWorkDetails(){")) return html;
  return html.replace(LEGACY_STOP_BUTTONS, DASHBOARD_STOP_BUTTONS)
    .replace("function renderWorkDetails(){", DASHBOARD_STOP_CONFIRMATION_SCRIPT + "function renderWorkDetails(){");
}
