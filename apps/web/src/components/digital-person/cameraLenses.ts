const rearLensPreference = 'workstep.camera.rear-lens'

export function readRearLens() {
  try { return localStorage.getItem(rearLensPreference) ?? '' }
  catch { return '' }
}

export function writeRearLens(deviceId: string) {
  try {
    if (deviceId) localStorage.setItem(rearLensPreference, deviceId)
    else localStorage.removeItem(rearLensPreference)
  } catch { /* Camera still works when browser storage is unavailable. */ }
}

export async function listRearLenses(mediaDevices: MediaDevices, activeRearId = '') {
  const devices = await mediaDevices.enumerateDevices?.() ?? []
  const rearIds = devices.filter(device => {
    if (device.kind !== 'videoinput' || !device.deviceId) return false
    if (device.deviceId === activeRearId) return true
    const facing = (device as InputDeviceInfo).getCapabilities?.().facingMode
    // Some Chromium Android versions only identify the camera direction in the label.
    return facing?.length ? facing.includes('environment') && !facing.includes('user')
      : /\bfacing back\b/i.test(device.label)
  }).map(device => device.deviceId)
  if (activeRearId && !rearIds.includes(activeRearId)) rearIds.unshift(activeRearId)
  return [...new Set(rearIds)]
}
