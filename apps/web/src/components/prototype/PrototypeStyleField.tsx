import {useId, useRef, useState} from 'react'
import {useI18n} from '../../i18n'

type Props={property:string;value:string;disabled:boolean;onPreview:(value:string)=>void;onCommit:(value:string)=>void;onResetPreview:()=>void}

function numeric(value:string,property:string){
  const match=value.trim().match(/^(-?(?:\d+\.?\d*|\.\d+))(px|%|rem|em|vw|vh)?$/i)
  if(!match)return null
  const number=Number(match[1]),unit=(match[2]||'').toLowerCase()
  if(!Number.isFinite(number)||(property!=='font-weight'&&!unit&&number!==0))return null
  if(property==='font-weight'&&unit)return null
  return {number,unit:property==='font-weight'?'':unit||'px'}
}

function maximum(property:string,unit:string){
  if(property==='font-weight')return 1000
  if(unit==='em'||unit==='rem')return 10
  if(unit!=='px')return 100
  if(property==='width'||property==='height')return 2000
  return property==='font-size'?96:128
}

export default function PrototypeStyleField({property,value,disabled,onPreview,onCommit,onResetPreview}:Props){
  const {t}=useI18n(),id=useId()
  const [text,setText]=useState(value||'')
  const [bounds,setBounds]=useState<Record<string,number>>({})
  const committed=useRef(value||'')
  const parsed=numeric(text,property),initial=numeric(value||'',property)
  const number=parsed||initial
  const min=property==='font-weight'?1:property==='margin'?Math.min(-128,initial?.number||0,bounds[`${number?.unit}:min`]||0):0
  const max=number?Math.max(maximum(property,number.unit),initial?.unit===number.unit?initial.number:0,bounds[number.unit]||0):0
  const valid=(next:string)=>Boolean(next.trim())&&next.length<=100&&!/[;{}<>\\]|url\s*\(|expression\s*\(|!important/i.test(next)&&window.CSS.supports(property,next)
  const change=(next:string)=>{
    setText(next);committed.current=value||''
    const nextNumber=numeric(next,property)
    if(nextNumber)setBounds(previous=>({...previous,[nextNumber.unit]:Math.max(previous[nextNumber.unit]||maximum(property,nextNumber.unit),nextNumber.number),[`${nextNumber.unit}:min`]:Math.min(previous[`${nextNumber.unit}:min`]||0,nextNumber.number)}))
    if(valid(next))onPreview(next);else onResetPreview()
  }
  const commit=(next=text)=>{
    if(disabled)return
    if(!valid(next)){onResetPreview();return}
    if(next!==committed.current){committed.current=next;onCommit(next)}
  }
  return <div className="prototype-style-field" onBlur={event=>{
    if(event.relatedTarget instanceof Node&&event.currentTarget.contains(event.relatedTarget))return
    const input=event.target as HTMLInputElement
    commit(input.type==='range'||input.type==='color'?text:input.value)
  }}>
    <label htmlFor={id}>{property}</label>
    <div className="prototype-property-value">
      {property.includes('color')&&<input type="color" aria-label={`${property} picker`} disabled={disabled} value={toHex(text)} onInput={event=>change(event.currentTarget.value)}/>}
      <input id={id} aria-label={property} disabled={disabled} value={text} aria-invalid={!valid(text)} title={!valid(text)?t('prototype.invalidStyle'):undefined}
        onChange={event=>change(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing)event.currentTarget.blur()}}/>
    </div>
    {number&&<input type="range" className="prototype-property-slider" aria-label={`${property} ${t('prototype.slider')}`}
      min={min} max={max} step={number.unit==='em'||number.unit==='rem'?.05:1} value={parsed?.number??number.number}
      disabled={disabled||!parsed||!valid(text)}
      onChange={event=>{if(number)change(`${Math.round(Number(event.target.value)*100)/100}${number.unit}`)}}
      onPointerUp={()=>commit()} onPointerCancel={()=>{setText(value||'');committed.current=value||'';onResetPreview()}}
      onKeyUp={event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))commit()}}/>}
  </div>
}

function toHex(value=''){
  if(/^#[0-9a-f]{6}$/i.test(value))return value
  const components=value.match(/^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/)
  return components?'#'+components.slice(1,4).map(value=>Number(value).toString(16).padStart(2,'0')).join(''):'#000000'
}
