export const SUPPORT_EMAIL = 'support@workstep.me'

export function SupportLink() {
  return <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
}
