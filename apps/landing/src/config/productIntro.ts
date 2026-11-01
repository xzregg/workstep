import chineseVideo from '../assets/workstep-intro-zh.mp4'
import englishVideo from '../assets/workstep-intro-en.mp4'
import chinesePoster from '../assets/workstep-intro-zh.jpg'
import englishPoster from '../assets/workstep-intro-en.jpg'
import chineseCaptions from '../assets/workstep-intro-zh.vtt?url'
import englishCaptions from '../assets/workstep-intro-en.vtt?url'
import type { Lang } from '../i18n'

const chinese = { language: 'zh', src: chineseVideo, poster: chinesePoster, captions: chineseCaptions }
const english = { language: 'en', src: englishVideo, poster: englishPoster, captions: englishCaptions }

export function getProductIntroMedia(locale: Lang) {
  return locale === 'zh-CN' || locale === 'zh-TW' ? chinese : english
}
