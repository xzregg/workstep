import { useI18n } from '../i18n'

export default function ArtifactUnchangedBadge({ fromRound }: { fromRound: number }) {
  const { t } = useI18n()
  return (
    <span
      className="artifact-unchanged-badge"
      title={t('taskDetail.artifactSameAsRoundTitle', { round: fromRound })}
      aria-label={t('taskDetail.artifactSameAsRoundTitle', { round: fromRound })}
    >
      {t('taskDetail.artifactSameAsRound', { round: fromRound })}
    </span>
  )
}
