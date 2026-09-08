/** Shared user-input and original approval form rendering. */
export const CARD_FORM_SCRIPT = String.raw`
  function questionFields(panel,questions){
    const fields=[];
    for(const question of questions){
      const label=node("label","message",question.question),input=document.createElement("input"),id="question-"+mutationId();
      input.id=id;input.type=question.isSecret?"password":"text";input.autocomplete="off";input.required=true;label.htmlFor=id;panel.append(label);
      const options=question.options||[];
      if(options.length){
        const select=document.createElement("select");select.id=id;input.id=id+"-other";select.required=true;
        const empty=node("option","","—");empty.value="";select.appendChild(empty);
        options.forEach((option,index)=>{const choice=node("option","",option.label);choice.value=String(index);choice.title=option.description||"";select.appendChild(choice)});
        if(question.isOther!==false){const other=node("option","",t["activity.otherAnswer"]);other.value="other";other.dataset.i18n="activity.otherAnswer";select.appendChild(other)}
        input.hidden=true;input.required=false;select.addEventListener("change",()=>{input.hidden=select.value!=="other";input.required=!input.hidden});panel.append(select,input);
        fields.push({id:question.id,valid:()=>select.reportValidity()&&(input.hidden||input.reportValidity()),read:()=>select.value==="other"?input.value:options[Number(select.value)].label});
      }else{panel.appendChild(input);fields.push({id:question.id,valid:()=>input.reportValidity(),read:()=>input.value})}
    }
    return fields;
  }
  function elicitationField(panel,key,schema,required){
    const multi=schema.type==="array",choiceSchema=multi?schema.items||{}:schema;
    const choices=Array.isArray(choiceSchema.enum)?choiceSchema.enum.map(value=>({value,label:String(value)})):(choiceSchema.oneOf||choiceSchema.anyOf||[]).filter(choice=>Object.prototype.hasOwnProperty.call(choice,"const")).map(choice=>({value:choice.const,label:choice.title||String(choice.const)}));
    const select=choices.length>0||schema.type==="boolean",input=document.createElement(select?"select":multi?"textarea":"input"),id="elicitation-"+mutationId(),label=node("label","message",schema.title||key);
    label.htmlFor=id;input.id=id;input.required=required;input.autocomplete="off";
    if(select){
      if(multi)input.multiple=true;else{const empty=node("option","","—");empty.value="";input.appendChild(empty)}
      if(schema.type==="boolean")choices.push({value:true,label:t["activity.yes"]},{value:false,label:t["activity.no"]});
      choices.forEach((choice,index)=>{const option=node("option","",choice.label);option.value=String(index);option.selected=multi?Array.isArray(schema.default)&&schema.default.includes(choice.value):schema.default===choice.value;input.appendChild(option)});
    }else{
      if(!multi)input.type=schema.type==="number"||schema.type==="integer"?"number":schema.format==="email"?"email":schema.format==="uri"?"url":"text";
      if(schema.type==="number")input.step="any";
      if(schema.minimum!=null)input.min=String(schema.minimum);if(schema.maximum!=null)input.max=String(schema.maximum);
      if(schema.minLength!=null)input.minLength=schema.minLength;if(schema.maxLength!=null)input.maxLength=schema.maxLength;
      if(schema.default!=null)input.value=multi?schema.default.join("\n"):String(schema.default);
    }
    panel.append(label,input);if(schema.description)panel.appendChild(node("div","meta",schema.description));
    return {key,valid:()=>input.reportValidity(),read:()=>{
      if(multi)return select?Array.from(input.selectedOptions).map(option=>choices[Number(option.value)].value):input.value.split("\n").filter(Boolean);
      if(input.value==="")return undefined;if(select)return choices[Number(input.value)].value;
      return schema.type==="number"||schema.type==="integer"?Number(input.value):input.value;
    }};
  }
`;
