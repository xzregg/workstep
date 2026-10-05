export function getExperienceHref(pathname: string): string {
  return pathname === '/landing' || pathname.startsWith('/landing/')
    ? '/'
    : 'workstep://open'
}
