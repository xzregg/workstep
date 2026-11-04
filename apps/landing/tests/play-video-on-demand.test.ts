import { describe, expect, it, vi } from 'vitest'
import { playVideoOnDemand } from '../src/demo/playVideoOnDemand'

describe('on-demand video playback', () => {
  it('attaches the video URL before playing from the user action', async () => {
    let source: string | null = null
    const play = vi.fn(() => {
      expect(source).toBe('intro.mp4')
      return Promise.resolve()
    })
    const video = {
      getAttribute: () => source,
      set src(value: string) { source = value },
      play,
    } as unknown as HTMLVideoElement

    expect(source).toBeNull()
    await playVideoOnDemand(video, 'intro.mp4')
    expect(play).toHaveBeenCalledOnce()
  })

  it('resumes without resetting the media URL and losing buffered progress', async () => {
    const setSource = vi.fn()
    const video = {
      getAttribute: () => 'intro.mp4',
      set src(value: string) { setSource(value) },
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement

    await playVideoOnDemand(video, 'intro.mp4')
    expect(setSource).not.toHaveBeenCalled()
    expect(video.play).toHaveBeenCalledOnce()
  })

  it('passes playback errors back to the player for recovery', async () => {
    const error = new Error('Playback failed')
    const video = {
      getAttribute: () => 'intro.mp4',
      play: vi.fn().mockRejectedValue(error),
    } as unknown as HTMLVideoElement
    await expect(playVideoOnDemand(video, 'intro.mp4')).rejects.toBe(error)
  })
})
