export function CompanySubtitle({ name }: { name: string }) {
  return name ? <p className="gateway-auth-company">{name}</p> : null
}
