import {useId,type ChangeEvent} from 'react'
import {useI18n} from '../../i18n'
import Input from '../Input'
import './DigitalPersonTraitField.css'

type Props = {
 name: string; label: string; value: string; presets: string[]; maxLength: number
 disabled?: boolean; multiline?: boolean; onChange: (value: string) => void
}

export default function DigitalPersonTraitField({name,label,value,presets,maxLength,disabled,multiline,onChange}:Props){
 const id=useId(),{t}=useI18n()
 const parts=value.split(/[、，,；;\n]+/).map(item=>item.trim()).filter(Boolean)
 const next=(preset:string)=>parts.includes(preset)?parts.filter(item=>item!==preset).join('、'):[...parts,preset].join('、')
 const input={id,name,value,maxLength,disabled,'aria-label':label,placeholder:t('digitalPerson.traitCustom'),onChange:(event:ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>onChange(event.target.value)}
 return <div className="digital-person-trait-field">
  <label htmlFor={id}>{label}</label>
  <div className="digital-person-trait-presets" role="group" aria-label={t('digitalPerson.traitPresets',{name:label})}>
   {presets.map(preset=><button type="button" key={preset} aria-pressed={parts.includes(preset)} disabled={disabled || next(preset).length>maxLength} onClick={()=>onChange(next(preset))}>{preset}</button>)}
  </div>
  {multiline?<textarea {...input}/>:<Input {...input}/>}
 </div>
}
