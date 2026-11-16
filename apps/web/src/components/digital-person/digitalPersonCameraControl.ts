import { createContext, useContext } from 'react'

export interface DigitalPersonCameraControl {
  enabled: boolean
  opening: boolean
  disabled: boolean
  prepare: (content: string, onFaces?: (ids:string[])=>void) => Promise<string>
  toggle: () => void
}

export const DigitalPersonCameraControlContext = createContext<DigitalPersonCameraControl | null>(null)
export const useDigitalPersonCameraControl = () => useContext(DigitalPersonCameraControlContext)
