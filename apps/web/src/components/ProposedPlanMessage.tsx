import { memo, useMemo, useState, type ComponentProps } from 'react'
import { useI18n } from '../i18n'
import { proposedPlanText } from '../utils/proposedPlanText'
import MarkdownMessage from './MarkdownMessage'
import { MessageCopyButton } from './MessageResponseFooter'

type MarkdownProps = ComponentProps<typeof MarkdownMessage>

export function MarkdownPlanCard(props: MarkdownProps) {
  const { t } = useI18n()
  return <section className="chat-proposed-plan" aria-label={t('plan.proposalTitle')}>
    <div className="chat-proposed-plan-header">
      <div className="chat-proposed-plan-title">{t('plan.proposalTitle')}</div>
      <MessageCopyButton content={props.content} className="chat-message-action" />
    </div>
    <MarkdownMessage {...props} />
  </section>
}

/** Keep the plan renderer mounted through delimiter completion and stream end.
 * The existing MarkdownMessage still owns reveal, selection and height. */
export default memo(function ProposedPlanMessage({ suppressPlan = false, ...props }: MarkdownProps & { suppressPlan?: boolean }) {
  const [revealInitial] = useState(() => props.revealInitial || (props.streaming && props.content.length === 0))
  const plan = useMemo(() => proposedPlanText(props.content, props.streaming === true), [props.content, props.streaming])
  if (!plan) return <MarkdownMessage {...props} />
  if ('pending' in plan) return <MarkdownMessage {...props} content="" />
  return <>
    {!suppressPlan && <MarkdownPlanCard {...props} content={plan.content} revealInitial={revealInitial} />}
    {plan.trailing.trim() && <MarkdownMessage {...props} content={plan.trailing} />}
  </>
})
