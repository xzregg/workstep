import { useI18n } from '../i18n'
import { acceptableUseCopy } from '../i18n/acceptableUse'

export function AcceptableUseLink() {
  const { lang } = useI18n()
  return <a href="#acceptable-use">{acceptableUseCopy[lang].title}</a>
}
