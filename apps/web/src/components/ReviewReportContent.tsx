import type { ReviewRun } from '../api/client'
import MarkdownMessage from './MarkdownMessage'

export interface ReviewReportContentProps {
  /** 已格式化的分数文案（如「90 分」）；为空则不展示分数行。 */
  scoreLabel?: string
  report: NonNullable<ReviewRun['report']>
  /** 用于解析报告里引用项目文件/图片的相对路径。 */
  projectId?: string
}

/**
 * 审核报告内容（分数 + 总结 + 问题清单）的统一渲染。
 *
 * 审核引擎产出的 summary / description / suggestion 都是 Markdown 文本，
 * 直接当纯文本渲染会把标题、列表和换行挤成一团；这里统一走 Markdown 渲染。
 * 任务详情的 owner 弹窗与分享页（SharedTaskView）都复用这一份实现，
 * 保证所有入口的审核内容展示一致。
 */
export default function ReviewReportContent({
  scoreLabel,
  report,
  projectId,
}: ReviewReportContentProps) {
  return (
    <>
      {scoreLabel && (
        <div
          className="review-report-score"
          style={{
            fontSize: 'calc(13px * var(--font-scale))',
            fontWeight: 600,
          }}
        >
          {scoreLabel}
        </div>
      )}
      {report.summary && (
        <MarkdownMessage
          content={report.summary}
          projectId={projectId}
          className="review-report-markdown review-report-summary"
        />
      )}
      {report.issues.map((issue, index) => (
        <div
          key={`${issue.category}-${index}`}
          className="review-report-issue"
          style={{
            fontSize: 'calc(11px * var(--font-scale))',
            lineHeight: 1.5,
            padding: '7px 9px',
            borderRadius: 6,
            background:
              issue.severity === 'error'
                ? 'color-mix(in oklab, var(--danger), transparent 90%)'
                : 'color-mix(in oklab, var(--warn), transparent 90%)',
          }}
        >
          <MarkdownMessage
            content={issue.description}
            projectId={projectId}
            className="review-report-markdown review-report-issue-description"
          />
          {issue.suggestion && (
            <div
              className="review-report-issue-suggestion"
              style={{ color: 'var(--muted)' }}
            >
              <MarkdownMessage
                content={issue.suggestion}
                projectId={projectId}
                className="review-report-markdown"
              />
            </div>
          )}
        </div>
      ))}
    </>
  )
}
