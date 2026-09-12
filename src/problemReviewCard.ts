export const PROBLEM_REVIEW_CSS = String.raw`
  .problem-filters,.problem-actions,.problem-page{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .problem-filters{margin-bottom:10px}.problem-tabs{display:flex;gap:4px;flex-wrap:wrap}
  .problem-tabs button[aria-pressed="true"]{background:color-mix(in srgb,Highlight 12%,Canvas);border-color:Highlight;color:CanvasText}
  .problem-kind{display:flex;align-items:center;gap:6px;font-size:12px}.problem-kind select{max-width:190px}
  .problem-actions{margin:8px 0}.problem-actions button,.problem-tabs button,.problem-page button{font:inherit;font-size:12px;cursor:pointer}
  .problem-row{padding:10px;margin-top:10px;border:1px solid var(--border);border-radius:10px}
  .problem-row .activity-agent{border:0;padding:0}.problem-reason{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;margin:8px 0}
  .problem-note{font-size:11px;line-height:1.5;color:var(--muted);margin:6px 0;overflow-wrap:anywhere}
  .problem-select{display:flex;gap:6px;align-items:center;font-size:12px;margin-bottom:8px}
  .problem-page{justify-content:space-between;margin-top:12px;font-size:12px}.problem-stop{color:var(--danger,#b42318)}
  .problem-confirm{padding:12px;border:1px solid var(--border);border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere}
`;

export const PROBLEM_REVIEW_MARKUP = String.raw`
  <section class="section" id="problem-section" hidden>
    <div class="section-head"><h2 data-i18n="dashboard.problems"></h2><span id="problem-list-count"></span></div>
    <div class="problem-filters">
      <div class="problem-tabs" role="group" data-i18n-aria="problem.reviewLabel">
        <button type="button" data-problem-review="pending" aria-pressed="true" data-i18n="problem.pending"></button>
        <button type="button" data-problem-review="acknowledged" aria-pressed="false" data-i18n="problem.acknowledged"></button>
        <button type="button" data-problem-view="actionable" hidden aria-pressed="true" data-i18n="problem.pending"></button>
        <button type="button" data-problem-view="history" hidden aria-pressed="false" data-i18n="problem.history"></button>
        <button type="button" data-problem-view="automatic" hidden aria-pressed="false" data-i18n="problem.automatic"></button>
      </div>
      <label class="problem-kind"><span data-i18n="problem.kindLabel"></span><select id="problem-kind">
        <option value="all" data-i18n="problem.kind.all"></option><option value="failed" data-i18n="problem.kind.failed"></option>
        <option value="unknown" data-i18n="problem.kind.unknown"></option><option value="termination-failed" data-i18n="problem.kind.termination-failed"></option>
        <option value="orphaned" data-i18n="problem.kind.orphaned"></option>
      </select></label>
    </div>
    <p id="problem-policy" class="problem-note" hidden></p>
    <div class="problem-actions"><button type="button" id="problem-ack-all" data-i18n="problem.ackAll"></button><button type="button" id="problem-ack-selected" data-i18n="problem.ackSelected"></button></div>
    <p id="problem-notice" class="problem-note" role="status" aria-live="polite"></p>
    <div id="problem-confirm" class="problem-confirm" hidden role="group"></div>
    <div id="problem-list"></div><p id="problem-empty" class="empty"></p>
    <div class="problem-page" id="problem-page" hidden><button type="button" id="problem-previous" data-i18n="problem.previous"></button><span id="problem-page-label"></span><button type="button" id="problem-next" data-i18n="problem.next"></button></div>
  </section>
`;

export const PROBLEM_REVIEW_SCRIPT = String.raw`
    let problemReview="pending",problemView="actionable",problemKind="all",problemOffset=0,problemMutationInFlight=false,problemNotice="",problemStopCandidate=null;
    const selectedProblemKeys=new Set();
    const problemElements={section:document.getElementById("problem-section"),list:document.getElementById("problem-list"),count:document.getElementById("problem-list-count"),kind:document.getElementById("problem-kind"),ackAll:document.getElementById("problem-ack-all"),ackSelected:document.getElementById("problem-ack-selected"),notice:document.getElementById("problem-notice"),confirm:document.getElementById("problem-confirm"),empty:document.getElementById("problem-empty"),page:document.getElementById("problem-page"),previous:document.getElementById("problem-previous"),next:document.getElementById("problem-next"),pageLabel:document.getElementById("problem-page-label")};
    function automaticProblemViews(){return view?.historyPolicy?.automaticRecovery===true}
    function problemQuery(){return {review:problemReview,kind:problemKind,offset:problemOffset,view:problemView}}
    function problemTarget(problem){return {problemKey:problem.problemKey,expectedRevision:problem.revision}}
    function problemError(error){const message=String(error?.message||error);if(/PROBLEM_TARGET_CHANGED|PROBLEM_REVIEW_STALE|PROBLEM_STOP_IMPACT_CHANGED/.test(message))return t["problem.changed"];if(message.includes("PROBLEM_INSPECTION_PENDING"))return t["problem.inspectPending"];return message}
    function problemButton(parent,title,handler,css=""){const button=node("button",css,title);button.type="button";button.disabled=busy;button.addEventListener("click",handler);parent.appendChild(button);return button}
    function syncProblemControls(){
      const data=view?.problems;for(const button of problemElements.section.querySelectorAll("button"))button.disabled=busy;
      for(const input of problemElements.section.querySelectorAll("input,select"))input.disabled=busy;
      problemElements.ackAll.disabled=busy||!(data?.reviewableCount>0);problemElements.ackSelected.disabled=busy||selectedProblemKeys.size===0;
      problemElements.previous.disabled=busy||!data?.page.hasPrevious;problemElements.next.disabled=busy||!data?.page.hasNext;
    }
    function resetProblems(){problemOffset=0;selectedProblemKeys.clear();problemNotice="";problemStopCandidate=null;problemElements.list.replaceChildren();problemElements.confirm.hidden=true}
    function renderProblems(next){
      const data=next.problems;problemElements.section.hidden=!data||selectedStatus!=="problems";
      if(!data)return;problemOffset=data.page.offset;problemElements.count.textContent=formatNumber(data.page.total);
      const automatic=next.historyPolicy?.automaticRecovery===true;
      for(const button of document.querySelectorAll("[data-problem-review]"))button.hidden=automatic;
      for(const button of document.querySelectorAll("[data-problem-view]")){button.hidden=!automatic;button.setAttribute("aria-pressed",String(button.dataset.problemView===problemView))}
      const policy=document.getElementById("problem-policy");policy.hidden=!automatic;policy.textContent=t[problemView==="history"?"problem.historyOptional":problemView==="automatic"?"problem.automaticLogNotice":"problem.autoNotice"];
      const reviewable=new Set(data.rows.filter(problem=>problem.canAcknowledge).map(problem=>problem.problemKey));
      for(const key of selectedProblemKeys)if(!reviewable.has(key))selectedProblemKeys.delete(key);
      for(const button of document.querySelectorAll("[data-problem-review]"))button.setAttribute("aria-pressed",String(button.dataset.problemReview===problemReview));
      problemElements.kind.value=problemKind;const mayReview=(automatic?problemView==="history":problemReview==="pending")&&["all","failed"].includes(problemKind);
      problemElements.ackAll.hidden=!mayReview;problemElements.ackSelected.hidden=!mayReview;problemElements.notice.textContent=problemNotice;
      problemElements.kind.closest("label").hidden=automatic&&problemView!=="actionable";
      problemElements.kind.querySelector('option[value="failed"]').hidden=automatic;
      problemElements.list.replaceChildren();
      for(const problem of data.rows){
        const article=node("article","problem-row"),body=node("div","activity-agent");article.dataset.problemKey=problem.problemKey;
        if(problem.canAcknowledge){const label=node("label","problem-select"),check=document.createElement("input");check.type="checkbox";check.checked=selectedProblemKeys.has(problem.problemKey);check.setAttribute("aria-label",t["problem.select"].replace("{name}",problem.row.agentName));check.addEventListener("change",()=>{if(check.checked)selectedProblemKeys.add(problem.problemKey);else selectedProblemKeys.delete(problem.problemKey);syncProblemControls()});label.append(check,document.createTextNode(t["problem.selectShort"]));article.appendChild(label)}
        appendAgentBody(body,{...problem.row,historyControls:null});article.appendChild(body);
        if(problem.reason)article.appendChild(node("p","problem-reason",problem.reason));else if(problem.source==="execution")article.appendChild(node("p","problem-note",t["problem.noDetails"]));
        if(problem.source==="runtime"){article.appendChild(node("p","problem-note",t["problem.observed"].replace("{time}",relativeTime(problem.observedAt))));if(problem.review==="pending")article.appendChild(node("p","problem-note",t["problem.liveNotice"]))}
        if(problem.acknowledgedAt)article.appendChild(node("p","problem-note",t["problem.ackAt"].replace("{time}",relativeTime(problem.acknowledgedAt))));
        if(problem.automatic){const action=problem.automatic;article.appendChild(node("p","problem-note",t["problem.auto."+action.kind]+" · "+t["problem.auto."+action.state]+" · "+t["problem.auto.attempts"].replace("{count}",formatNumber(action.attempts))));
          const reason=action.evidence?"confirmed":action.reason==="work-changed"?"changed":/active-work|background|pending-request|shared-worker/.test(action.reason)?"protected":"unconfirmed";
          if(action.reason!=="inspection-pending")article.appendChild(node("p","problem-note",t["problem.auto."+reason]));if(problem.source==="recovery")article.appendChild(node("p","problem-note",relativeTime(problem.observedAt)))}
        const actions=node("div","problem-actions");
        if(problem.canAcknowledge)problemButton(actions,t["history.acknowledge"],()=>void runProblemAction("acknowledge",[problem]));
        if(problem.canUnacknowledge)problemButton(actions,t["problem.undo"],()=>void runProblemAction("unacknowledge",[problem]));
        if(problem.canRecheck)problemButton(actions,t["problem.recheck"],()=>void runProblemAction("recheck",[problem]));
        if(problem.canRetryStop)problemButton(actions,t["problem.retryStop"],()=>showProblemStop(problem),"problem-stop");
        article.appendChild(actions);problemElements.list.appendChild(article);
      }
      problemElements.empty.hidden=data.rows.length>0;problemElements.empty.textContent=t[automatic?(problemView==="history"?"problem.historyEmpty":problemView==="automatic"?"problem.automaticEmpty":"problem.empty"):problemReview==="pending"?"problem.empty":"problem.emptyAcknowledged"];
      problemElements.page.hidden=!data.page.hasPrevious&&!data.page.hasNext;
      problemElements.pageLabel.textContent=formatNumber(data.page.offset+1)+"–"+formatNumber(data.page.offset+data.page.returned)+" / "+formatNumber(data.page.total);
      if(problemStopCandidate&&!data.rows.some(problem=>problem.problemKey===problemStopCandidate.problemKey&&problem.revision===problemStopCandidate.revision)){problemStopCandidate=null;problemElements.confirm.hidden=true}
      syncProblemControls();
    }
    function showProblemStop(problem){if(busy)return;problemStopCandidate=problem;const box=problemElements.confirm;box.replaceChildren();box.hidden=false;
      box.appendChild(node("p","",t["problem.stopConfirm"].replace("{count}",formatNumber(problem.stopImpact.affectedJobIds.length))));
      box.appendChild(node("p","problem-note",problem.stopImpact.agentNames.filter(Boolean).join(", ")));
      problemButton(box,t["problem.retryStop"],()=>{problemStopCandidate=null;box.hidden=true;void runProblemAction("retry-stop",[problem])},"problem-stop");
      problemButton(box,t["common.cancel"],()=>{problemStopCandidate=null;box.hidden=true;scheduleSizeChanged(true)});box.querySelector("button")?.focus();scheduleSizeChanged(true);
    }
    async function dispatchProblemOperation(action,problems){
      const operation={action,targets:problems.map(problemTarget),...(action==="retry-stop"?{acknowledgeAffectedJobIds:problems[0].stopImpact.affectedJobIds}:{})};
      const read=await callTool("codex_ui_read",{view:"problem-control",operation,scope:selectedScope,widgetInstanceId});
      const result=normalizeHostToolResult(read);if(result?.isError)throw new Error(errorText(result));
      const proof=hostToolResultMetadata(read)["codex/problemControl@1"];if(!proof?.token)throw new Error(t["problem.changed"]);
      const updated=normalizeHostToolResult(await callTool("codex_ui_problem",{...operation,widgetInstanceId,token:proof.token,requestId:mutationId()},false));
      if(updated?.isError||updated?.structuredContent?.ok!==true)throw new Error(errorText(updated));return updated.structuredContent.changed;
    }
    async function collectFinishedProblems(){
      let offset=0,revision=null;const problems=[];
      for(;;){const snapshot=unwrap(await callTool("codex_ui_read",{view:"dashboard",widgetInstanceId,scope:selectedScope,statusFilter:"problems",limit:50,enrich:false,includeHistory:false,problems:{review:"pending",kind:"failed",offset,...(automaticProblemViews()?{view:"history"}:{})}}));
        const data=snapshot.problems;if(!data||data.page.offset!==offset||revision!==null&&revision!==data.revision)throw new Error(t["problem.changed"]);revision=data.revision;
        problems.push(...data.rows.filter(problem=>problem.canAcknowledge));if(!data.page.hasNext)break;if(!data.page.returned)throw new Error(t["problem.changed"]);offset+=data.page.returned;
      }return problems;
    }
    async function runProblemAction(action,problems,all=false){
      if(busy||!mounted)return;++hydrationEpoch;problemMutationInFlight=true;problemNotice="";setBusy(true);let failure=null,changed=0;
      try{if(all)problems=await collectFinishedProblems();for(let start=0;start<problems.length;start+=100){if(!mounted)break;changed+=await dispatchProblemOperation(action,problems.slice(start,start+100))}
        problemOffset=0;selectedProblemKeys.clear();problemNotice=action==="recheck"?t["problem.rechecked"]:action==="acknowledge"?t["problem.ackDone"].replace("{count}",formatNumber(changed)):"";
      }catch(error){failure=error;if(changed>0)problemNotice=t["problem.ackDone"].replace("{count}",formatNumber(changed))}
      finally{problemMutationInFlight=false;setBusy(false)}
      if(mounted){await reload(true);if(failure)showError(new Error(problemError(failure)))}
    }
    async function selectProblemQuery({review=problemReview,kind=problemKind,offset=0,view:nextView=problemView}){if(busy||!mounted)return;problemReview=review;problemView=nextView;problemKind=kind;problemOffset=offset;selectedProblemKeys.clear();problemNotice="";problemStopCandidate=null;problemElements.confirm.hidden=true;await reload(true,false)}
    for(const button of document.querySelectorAll("[data-problem-review]"))button.addEventListener("click",()=>void selectProblemQuery({review:button.dataset.problemReview}));
    for(const button of document.querySelectorAll("[data-problem-view]"))button.addEventListener("click",()=>void selectProblemQuery({view:button.dataset.problemView,kind:"all"}));
    problemElements.kind.addEventListener("change",()=>void selectProblemQuery({kind:problemElements.kind.value}));
    problemElements.ackAll.addEventListener("click",()=>void runProblemAction("acknowledge",[],true));
    problemElements.ackSelected.addEventListener("click",()=>void runProblemAction("acknowledge",(view?.problems?.rows||[]).filter(problem=>selectedProblemKeys.has(problem.problemKey)&&problem.canAcknowledge)));
    problemElements.previous.addEventListener("click",()=>void selectProblemQuery({offset:Math.max(0,view.problems.page.offset-view.problems.page.limit)}));
    problemElements.next.addEventListener("click",()=>void selectProblemQuery({offset:view.problems.page.offset+view.problems.page.returned}));
`;
