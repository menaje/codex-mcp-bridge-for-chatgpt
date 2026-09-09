/** Unsubmitted input stays in this tab's browser session, never in tool output
 * or model context. Hosts that block storage still support in-memory drafts. */
export const QUESTION_DRAFT_SCRIPT = String.raw`
function questionDraftCache(){
  const prefix="codex.question.draft.v1:";
  function storage(){try{return window.sessionStorage}catch{return null}}
  function key(question){return prefix+question.questionId}
  function shape(question){return JSON.stringify(question.questions.map(field=>[field.id,field.options?.map(option=>option.label)||null,field.isOther!==false]))}
  function pending(question){return question?.status==="pending"&&Date.now()<question.expiresAt}
  function clear(question){if(!question?.questionId)return;try{storage()?.removeItem(key(question))}catch{}}
  function prune(store){
    for(const name of Object.keys(store)){
      if(!name.startsWith(prefix))continue;
      try{const value=JSON.parse(store.getItem(name));if(!Number.isFinite(value?.expiresAt)||value.expiresAt<=Date.now())store.removeItem(name)}catch{try{store.removeItem(name)}catch{}}
    }
  }
  function read(question){
    if(!pending(question)){clear(question);return []}
    try{
      const store=storage();if(!store)return [];prune(store);
      const draft=JSON.parse(store.getItem(key(question))||"null");if(!draft)return [];
      if(draft.scopeId!==(question.scopeId||null)||draft.revision!==question.revision||draft.expiresAt!==question.expiresAt||draft.shape!==shape(question)||!Array.isArray(draft.values)||draft.values.length>question.questions.length*2||!draft.values.every(value=>typeof value==="string"&&value.length<=2000)){clear(question);return []}
      return draft.values;
    }catch{return []}
  }
  function save(question,values){
    if(!pending(question)||!values.some(value=>value!=="")){clear(question);return}
    try{storage()?.setItem(key(question),JSON.stringify({scopeId:question.scopeId||null,revision:question.revision,expiresAt:question.expiresAt,shape:shape(question),values:values.map(value=>value.slice(0,2000))}))}catch{}
  }
  return {read,save,clear};
}
`;
