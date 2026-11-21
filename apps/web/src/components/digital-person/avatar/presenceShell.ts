export const shellOrigin=[.22,-.17] as const
export const coreDrop=.10

// A bounded radial field keeps the silhouette round at every angle.
export function shellRadius(x:number,y:number,z:number){
 return .63+.018*Math.sin(4*x+5*y-2*z)+.012*Math.cos(7*z-6*y)+.008*Math.sin(9*x+4*z)
}

export const filamentCount=13

export function filamentPoint(filament:number,u:number){
 const curl=.59*Math.sin(u*2.7+filament)+.38*u
 const angle=filament*2.40+curl
 const radius=.035+u*(.39+(filament%5)*.058)
 const depth=.77*Math.sin(filament*1.83+1.28*u)
 const plane=radius*Math.sqrt(1-depth*depth)
 return [
  shellOrigin[0]+plane*Math.cos(angle),
  shellOrigin[1]+plane*Math.sin(angle)-coreDrop*(1-u),
  radius*depth,
 ] as const
}
