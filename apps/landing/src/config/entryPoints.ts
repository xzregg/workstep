import { RELEASES_URL } from './downloads'

export function getExperienceHref(pathname: string): string {
  return pathname === '/landing' || pathname.startsWith('/landing/')
    ? '/'
    : RELEASES_URL
}
