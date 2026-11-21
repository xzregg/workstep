import { createContext, useContext } from 'react'

export interface DigitalPersonCameraControl {
  enabled: boolean
  opening: boolean
  disabled: boolean
  prepare: import('./DigitalPersonCamera').PrepareCameraMessage
  toggle: () => void
}

export const DigitalPersonCameraControlContext = createContext<DigitalPersonCameraControl | null>(null)
export const useDigitalPersonCameraControl = () => useContext(DigitalPersonCameraControlContext)
