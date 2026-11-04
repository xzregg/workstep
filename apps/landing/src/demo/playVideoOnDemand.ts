// Attach the media URL only from a user action, then let the browser buffer playback.
export function playVideoOnDemand(video: HTMLVideoElement, src: string) {
  if (!video.getAttribute('src')) video.src = src
  return video.play()
}
