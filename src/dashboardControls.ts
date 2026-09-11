/** Detail controls are opened deliberately; overview refreshes never overwrite
 * their form or dispatch an action. Domain mutations are never auto-retried. */
export const DASHBOARD_CONTROL_SCRIPT = String.raw`
let selectedControlRow=null,controlDetail=null,controlBusy=false,controlEpoch=0;
const controlHosts=new Map(),controlPanel=document.getElementById("work-details-template").content.firstElementChild,controlBody=controlPanel.querySelector("#work-details-body"),controlMessage=controlPanel.querySelector("#work-details-message"),controlHeading=controlPanel.querySelector("#work-details-title"),controlRefresh=controlPanel.querySelector("#work-details-refresh"),controlClose=controlPanel.querySelector("#work-details-close");
function mutationId(){return createWidgetInstanceId()}
function actionButton(label,action){const button=node("button","",label);button.type="button";button.addEventListener("click",action);return button}
function appendWorkControl(body,row){
 if(row.controlKind!=="request")return;
 const host=node("div","work-control"),button=actionButton("",()=>void openWorkDetails(row.rowKey)),chevron=node("span","chevron");
 host.dataset.controlRow=row.rowKey;button.className="work-control-toggle";chevron.setAttribute("aria-hidden","true");button.append(chevron,node("span","",t["dashboard.control.requests"]));
 button.setAttribute("aria-expanded",String(selectedControlRow===row.rowKey));if(selectedControlRow===row.rowKey)button.setAttribute("aria-controls","work-details");host.appendChild(button);controlHosts.set(row.rowKey,host);body.appendChild(host);
}
// Keep the same form nodes across structural/enriched paints, including focus
// and draft answers. The selected panel follows its owning row between buckets.
function prepareWorkControlPaint(){const focused=controlPanel.contains(document.activeElement)?document.activeElement:null;controlPanel.remove();controlHosts.clear();return focused}
function finishWorkControlPaint(focused){if(!selectedControlRow)return;const host=controlHosts.get(selectedControlRow);if(!host){closeWorkDetails(false);return}host.appendChild(controlPanel);if(focused?.isConnected)focused.focus({preventScroll:true})}
function closeWorkDetails(restoreFocus=true){const button=controlHosts.get(selectedControlRow)?.querySelector("button");if(button){button.setAttribute("aria-expanded","false");button.removeAttribute("aria-controls")}selectedControlRow=null;controlDetail=null;++controlEpoch;controlPanel.hidden=true;controlPanel.remove();controlBody.replaceChildren();setControlBusy(false);if(restoreFocus&&button?.isConnected)button.focus({preventScroll:true});scheduleSizeChanged(true)}
function controlError(error){const code=String(error?.message||error).match(/\b[A-Z][A-Z0-9_]{2,}\b/);controlMessage.textContent=code?t["common.errorCode"].replace("{code}",code[0]):t["common.error"];controlMessage.classList.add("error");scheduleSizeChanged(true)}
function setControlBusy(value){controlBusy=value;controlRefresh.disabled=value;for(const field of controlBody.querySelectorAll("input,select,textarea,button"))field.disabled=value||!controlDetail||field.dataset.unavailable==="true"}
async function openWorkDetails(rowKey){if(selectedControlRow===rowKey){closeWorkDetails();return}closeWorkDetails(false);const host=controlHosts.get(rowKey);if(!host)return;selectedControlRow=rowKey;const button=host.querySelector("button");button.setAttribute("aria-expanded","true");button.setAttribute("aria-controls","work-details");controlHeading.textContent=button.textContent;controlClose.textContent=t["dashboard.control.close"];controlRefresh.textContent=t["common.refresh"];host.appendChild(controlPanel);controlPanel.hidden=false;scheduleSizeChanged(true);await refreshWorkDetails()}
async function refreshWorkDetails(){if(!selectedControlRow||controlBusy)return;const rowKey=selectedControlRow,epoch=++controlEpoch;setControlBusy(true);controlMessage.textContent=t["common.loading"];controlMessage.classList.remove("error");try{const result=await callTool("codex_ui_read",{view:"control",rowKey,widgetInstanceId});const normalized=normalizeHostToolResult(result);if(normalized?.isError)throw new Error(errorText(normalized));const detail=hostToolResultMetadata(result)["codex/uiControl@1"];if(!detail?.card||detail.rowKey!==rowKey)throw new Error(t["common.error"]);if(mounted&&epoch===controlEpoch&&selectedControlRow===rowKey){controlDetail=detail;renderWorkDetails()}}catch(error){if(mounted&&epoch===controlEpoch){controlDetail=null;controlError(error)}}finally{if(epoch===controlEpoch)setControlBusy(false);scheduleSizeChanged(true)}}
function controlDecisionLabel(value){return value==="accept"?t["activity.approve"]:value==="acceptForSession"?t["activity.approveSession"]:value==="decline"?t["activity.decline"]:t["common.cancel"]}
async function controlAction(name,args){if(controlBusy||!controlDetail)return;const rowKey=selectedControlRow,epoch=controlEpoch;setControlBusy(true);try{const result=normalizeHostToolResult(await callTool(name,{...args,widgetInstanceId,requestId:mutationId(),card:controlDetail.card},false));if(result?.isError||result?.structuredContent?.ok===false)throw new Error(errorText(result));if(mounted&&selectedControlRow===rowKey&&epoch===controlEpoch){setControlBusy(false);await refreshWorkDetails();void reload(true)}}catch(error){if(mounted&&epoch===controlEpoch)controlError(error)}finally{if(epoch===controlEpoch)setControlBusy(false)}}
function answerInteraction(interaction,response){return controlAction("codex_interaction_respond",{jobId:controlDetail.jobId,expectedJobVersion:controlDetail.jobVersion,interactionId:interaction.interactionId,response})}
function controlInteraction(interaction){
 const panel=node("div","interaction");panel.append(node("strong","",interaction.kind==="user-input"||interaction.kind==="mcp-elicitation"?t["activity.inputRequired"]:t["activity.approval"]),node("p","message",interaction.summary));
 const context=[interaction.cwdLabel,interaction.grantRootLabel,interaction.networkContext?interaction.networkContext.protocol+"://"+interaction.networkContext.host:null].filter(Boolean);if(context.length)panel.appendChild(node("div","meta",context.join(" · ")));
 if(interaction.ordinary){panel.appendChild(node("p","message",t["question.gptHandles"]));return panel}
 if(interaction.isBlocking===false)panel.appendChild(node("p","message",t["activity.optionalInput"]));
 if(interaction.kind==="mcp-elicitation"){
  const request=interaction.elicitation||{},fields=[],schema=request.requestedSchema;
  if(request.mode==="url"&&request.url){const url=new URL(request.url);if(url.protocol!=="https:"&&url.protocol!=="http:")throw new Error(t["common.error"]);const link=node("a","conversation-link",t["activity.openRequest"]);link.href=url.href;link.target="_blank";link.rel="noopener noreferrer";link.referrerPolicy="no-referrer";panel.appendChild(link)}
  else if(request.mode==="form"&&schema?.properties){for(const [key,field] of Object.entries(schema.properties))fields.push(elicitationField(panel,key,field,(schema.required||[]).includes(key)))}
  else panel.appendChild(node("p","message",t["common.error"]));
  const actions=node("div","actions");for(const action of ["accept","decline","cancel"]){const button=actionButton(controlDecisionLabel(action),()=>{if(action==="accept"&&!fields.every(field=>field.valid()))return;const content=action==="accept"&&request.mode==="form"?Object.fromEntries(fields.map(field=>[field.key,field.read()]).filter(entry=>entry[1]!==undefined)):null;void answerInteraction(interaction,{elicitation:{action,content}})});if(action==="accept"&&!request.url&&!schema){button.disabled=true;button.dataset.unavailable="true"}actions.appendChild(button)}panel.appendChild(actions);return panel;
 }
 if(interaction.kind==="user-input"){const fields=questionFields(panel,interaction.questions||[]);panel.appendChild(actionButton(t["activity.answer"],()=>{if(fields.every(field=>field.valid()))void answerInteraction(interaction,{answers:Object.fromEntries(fields.map(field=>[field.id,[field.read()]]))})}));return panel}
 const actions=node("div","actions");for(const decision of interaction.availableDecisions||[])actions.appendChild(actionButton(controlDecisionLabel(decision),()=>void answerInteraction(interaction,{decision})));panel.appendChild(actions);return panel;
}
function renderWorkDetails(){
 const detail=controlDetail;if(!detail)return;controlMessage.textContent=statusLabel(detail.status);controlMessage.classList.remove("error");controlBody.replaceChildren();
 for(const interaction of detail.pendingInteractions||[])controlBody.appendChild(controlInteraction(interaction));
 if(!controlBody.childElementCount)controlBody.appendChild(node("p","message",t["dashboard.control.empty"]));scheduleSizeChanged(true);
}
controlRefresh.addEventListener("click",()=>void refreshWorkDetails());controlClose.addEventListener("click",()=>closeWorkDetails());
window.addEventListener("pagehide",()=>{++controlEpoch;controlDetail=null;setControlBusy(false)});
window.addEventListener("pageshow",event=>{if(event.persisted&&selectedControlRow)void refreshWorkDetails()});
`;
