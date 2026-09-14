/** ChatGPT's sandbox omits allow-modals: native confirm() cannot authorize a
 * stop there. Keep the confirmation in the card and bound to the displayed read. */
export const DASHBOARD_STOP_CONFIRMATION_SCRIPT = String.raw`
function confirmControlStop(detail,args){
 if(controlBusy||controlDetail!==detail)return;
 controlBody.querySelector("#work-stop-confirmation")?.remove();
 const panel=node("section","interaction"),target=[detail.projectName,detail.activityTitle,detail.agentName,args.processId].filter(Boolean).join(" · ");
 panel.id="work-stop-confirmation";panel.setAttribute("role","group");panel.setAttribute("aria-label",t["dashboard.control.stop"]);
 panel.append(node("strong","",t["dashboard.control.stop"]),node("p","message",target),node("p","message",t["problem.stopConfirm"].replace("{count}",String((detail.affectedJobIds||[]).length||1))));
 const actions=node("div","actions"),cancel=actionButton(t["common.cancel"],()=>{panel.remove();scheduleSizeChanged(true)});
 actions.append(cancel,actionButton(t["dashboard.control.stop"],()=>{if(controlDetail!==detail||!panel.isConnected||controlBusy)return;void controlAction("codex_ui_stop",args)}));
 panel.appendChild(actions);controlBody.appendChild(panel);cancel.focus();panel.scrollIntoView({block:"nearest"});scheduleSizeChanged(true);
}
`;

export const DASHBOARD_STOP_BUTTONS = String.raw`
 if(detail.canStop)controlBody.appendChild(actionButton(t["dashboard.control.stop"],()=>confirmControlStop(detail,{kind:"job",jobId:detail.jobId,expectedJobVersion:detail.jobVersion,acknowledgeAffectedJobIds:detail.affectedJobIds})));
 for(const process of detail.backgroundProcesses||[]){const row=node("div","actions");row.append(node("span","meta",process.processId),actionButton(t["dashboard.control.stop"],()=>confirmControlStop(detail,{kind:"process",agentId:detail.agentId,expectedAgentVersion:detail.agentVersion,processId:process.processId})));controlBody.appendChild(row)}
`;
