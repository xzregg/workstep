export const SUPPORT_EMAIL = 'xzregg@gmail.com'

export function SupportLink() {
  return <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
}
