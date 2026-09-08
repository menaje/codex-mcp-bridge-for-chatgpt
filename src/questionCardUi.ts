/** Runs inside the Activity renderer, using its existing MCP transport,
 * localization, form controls and sizing. Never obtains an Activity lease. */
export const QUESTION_CARD_SCRIPT = String.raw`
  let userQuestion=null,questionEpoch=0,questionBusy=false,questionExpiryTimer=null,questionFormId=null;
  function refreshQuestionLocale(){if(!userQuestion||!userQuestion.status)return;document.title=userQuestion.title||t["question.title"];activityHeading.textContent=document.title;if(userQuestion.status==="pending"&&Date.now()<userQuestion.expiresAt)message.textContent=t["question.pending"];else renderUserQuestion()}
  function questionProof(){if(!userQuestion)throw new Error("QUESTION_UNAVAILABLE");return{questionId:userQuestion.questionId,revision:userQuestion.revision,presentationToken:userQuestion.presentationToken,...(userQuestion.scopeId?{scopeId:userQuestion.scopeId}:{})}}
  function questionCurrent(proof){return mounted&&userQuestion&&userQuestion.questionId===proof.questionId&&userQuestion.presentationToken===proof.presentationToken}
  async function hydrateQuestion(proof){
    if(!proof||!proof.presentationToken)throw new Error("QUESTION_UNAVAILABLE");
    const epoch=++questionEpoch;userQuestion=Object.assign({},userQuestion&&userQuestion.questionId===proof.questionId?userQuestion:{},proof);
    invalidateWatch();snapshot=null;if(handoffTimer){clearTimeout(handoffTimer);handoffTimer=null}
    recoveryAction=null;setBusy(false);updateRefreshLabel();setCardVisible(true);activityHeading.textContent=t["question.title"];currentCount.textContent="";weeklyUsage.hidden=true;groups.replaceChildren();
    const result=unwrap(await callTool("codex_question_card",questionProof()));
    if(epoch!==questionEpoch||!questionCurrent(proof))return;
    if(!result||!result.question)throw new Error("QUESTION_UNAVAILABLE");
    userQuestion=result.question;localePreference=userQuestion.uiLocalePreference||"auto";setLocale(effectiveLocaleTag(),false);renderUserQuestion();
  }
  function showQuestionError(error){const raw=String(error&&error.message||error||"");if(/QUESTION_(UNAVAILABLE|STALE)/.test(raw)){activeList.replaceChildren();message.textContent=t["question.expired"];scheduleSizeChanged()}else showError(error)}
  function renderUserQuestion(){
    if(!userQuestion)return;const draft=questionFormId===userQuestion.questionId?Array.from(activeList.querySelectorAll("input,select"),field=>field.value):[];questionFormId=null;setCardVisible(true);activityHeading.textContent=userQuestion.title||t["question.title"];document.title=activityHeading.textContent;
    weeklyUsage.hidden=true;currentCount.textContent="";groups.replaceChildren();activeList.replaceChildren();message.classList.remove("error");updated.textContent="";
    if(questionExpiryTimer)clearTimeout(questionExpiryTimer);
    if(!userQuestion.expiresAt||Date.now()>=userQuestion.expiresAt){message.textContent=t["question.expired"];scheduleSizeChanged();return}
    questionExpiryTimer=setTimeout(renderUserQuestion,Math.max(1,userQuestion.expiresAt-Date.now()));
    if(userQuestion.status!=="pending"){
      const state=userQuestion.consumed?"consumed":userQuestion.notification==="requested"?"requested":userQuestion.notification==="uncertain"||userQuestion.notification==="dispatching"?"uncertain":userQuestion.status==="cancelled"?"cancelled":"stored";
      message.textContent=t["question."+state];
      if(!userQuestion.consumed&&["stored","failed"].includes(userQuestion.notification)){const button=actionButton(t["question.retry"],()=>void notifyQuestion());button.disabled=questionBusy;activeList.appendChild(button)}
      scheduleSizeChanged();return;
    }
    const panel=node("div","interaction"),fields=questionFields(panel,userQuestion.questions||[]);
    const submit=actionButton(t["question.submit"],()=>{if(!fields.every(field=>field.valid()))return;void submitQuestion({answers:Object.fromEntries(fields.map(field=>[field.id,[field.read()]]))})});
    const cancel=actionButton(t["common.cancel"],()=>void submitQuestion({cancel:true}));
    submit.dataset.i18n="question.submit";cancel.dataset.i18n="common.cancel";
    panel.append(submit,cancel);activeList.appendChild(panel);message.textContent=t["question.pending"];
    questionFormId=userQuestion.questionId;Array.from(activeList.querySelectorAll("input,select")).forEach((field,index)=>{if(draft[index]!==undefined)field.value=draft[index]});for(const select of activeList.querySelectorAll("select"))select.dispatchEvent(new Event("change"));
    setQuestionBusy(questionBusy);scheduleSizeChanged();
  }
  function setQuestionBusy(value){questionBusy=value;for(const field of activeList.querySelectorAll("input,select,button"))field.disabled=value}
  async function submitQuestion(response){
    if(questionBusy)return;const proof=questionProof();setQuestionBusy(true);
    try{
      const result=unwrap(await callTool("codex_question_submit",Object.assign({},proof,{response}),TOOL_CALL_TIMEOUT_MS,false));
      if(!questionCurrent(proof))return;userQuestion=result.question;setQuestionBusy(false);renderUserQuestion();await notifyQuestion();
    }catch(error){if(questionCurrent(proof)){showError(error);setQuestionBusy(false)}}
  }
  async function notifyQuestion(){
    if(questionBusy)return;const proof=questionProof();setQuestionBusy(true);let claim;
    try{
      claim=unwrap(await callTool("codex_question_notify",Object.assign({},proof,{operation:{kind:"claim"}}),TOOL_CALL_TIMEOUT_MS,false));
      if(!questionCurrent(proof))return;
      if(claim.send){
        const prompt="The user's question-card response is available. Read codex_user_answer with responseRef "+claim.responseRef+", then decide the next action within the user's delegation. This notification is not approval for a Codex operation.";
        const standard=standardBridgeInitialized||await beginStandardBridge();let result;
        if(standard)result=await rpcRequest("ui/message",{role:"user",content:[{type:"text",text:prompt}]},10000);
        else if(window.openai&&typeof window.openai.sendFollowUpMessage==="function")result=await withUiToolCallTimeout(()=>window.openai.sendFollowUpMessage({prompt}),10000,t["common.error"]);
        else throw new Error("FOLLOW_UP_UNAVAILABLE");
        const rejected=result&&(result.isError===true||result.error);
        await callTool("codex_question_notify",Object.assign({},proof,{operation:{kind:"ack",attempt:claim.attempt,state:rejected?"failed":"requested"}}),TOOL_CALL_TIMEOUT_MS,false);
      }
      if(questionCurrent(proof)){setQuestionBusy(false);await hydrateQuestion(proof)}
    }catch(error){
      if(claim&&claim.send)await callTool("codex_question_notify",Object.assign({},proof,{operation:{kind:"ack",attempt:claim.attempt,state:"uncertain"}}),TOOL_CALL_TIMEOUT_MS,false).catch(()=>{});
      if(questionCurrent(proof)){setQuestionBusy(false);await hydrateQuestion(proof).catch(()=>showError(error));message.textContent=t["question.uncertain"]}
    }
  }
`;
