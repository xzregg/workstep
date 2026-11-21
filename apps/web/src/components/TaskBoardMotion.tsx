import { Component, createRef, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  className: string
  scope: string | null
  layout: string
}

type CardPosition = { card: HTMLElement; rect: DOMRect; lane: string | undefined }

const selector = '[data-board-task-id]'
const settle = 'cubic-bezier(.22,.72,.2,1)'

function intersects(a: DOMRect, b: DOMRect) {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom
}

function measure(board: HTMLElement) {
  const positions = new Map<string, CardPosition>()
  const viewport = board.getBoundingClientRect()
  for (const card of board.querySelectorAll<HTMLElement>(selector)) {
    const rect = card.getBoundingClientRect()
    const lane = card.closest<HTMLElement>('[data-board-lane]')
    if (intersects(rect, viewport) && (!lane || intersects(rect, lane.getBoundingClientRect()))) {
      positions.set(card.dataset.boardTaskId!, { card, rect, lane: lane?.dataset.boardLane })
    }
  }
  return positions
}

// Read the old positions before React moves cards between column subtrees.
export default class TaskBoardMotion extends Component<Props> {
  private board = createRef<HTMLDivElement>()
  private motion = new Map<HTMLElement, () => void>()
  private flights = new Map<string, HTMLElement>()
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

  componentDidMount() {
    window.addEventListener('resize', this.stop)
    this.reduced.addEventListener?.('change', this.stop)
  }

  componentWillUnmount() {
    this.stop()
    window.removeEventListener('resize', this.stop)
    this.reduced.removeEventListener?.('change', this.stop)
  }

  getSnapshotBeforeUpdate(previous: Props) {
    const board = this.board.current
    if (!board || !this.props.scope || previous.scope !== this.props.scope ||
      previous.layout === this.props.layout || typeof HTMLElement.prototype.animate !== 'function' ||
      document.visibilityState === 'hidden') return null
    const before = measure(board)
    for (const [id, flight] of this.flights) {
      const position = before.get(id)
      if (position) before.set(id, { ...position, card: flight, rect: flight.getBoundingClientRect() })
    }
    return before
  }

  componentDidUpdate(previous: Props, _state: unknown, before: Map<string, CardPosition> | null) {
    if (previous.scope !== this.props.scope) this.stop()
    const board = this.board.current
    if (!before || !board) return
    const previousIds = new Set<string>(JSON.parse(previous.layout).flat())
    const after = measure(board)
    const viewport = board.getBoundingClientRect()

    for (const [id, previousPosition] of before) {
      if (!after.has(id)) this.motion.get(previousPosition.card)?.()
    }
    for (const [id, position] of after) {
      const { card, rect, lane } = position
      const source = before.get(id)
      if (!source && previousIds.has(id)) continue
      if (!source || source.lane !== lane) {
        if (this.reduced.matches) {
          this.play(card, [{ opacity: .65 }, { opacity: 1 }], 150)
        } else if (!source) {
          this.play(card, [
            { opacity: 0, transform: 'translateY(-16px) scale(1.025)', boxShadow: 'var(--elev-raised)' },
            { opacity: 1, transform: 'none', boxShadow: '0 0 0 transparent' },
          ], 340)
        } else {
          this.fly(id, source, position, viewport)
        }
      } else if (!this.reduced.matches && Math.abs(source.rect.top - rect.top) > 1 && !this.flights.has(id)) {
        const shift = source.rect.top - rect.top
        this.play(card, [{ transform: `translateY(${shift}px)` }, { transform: 'none' }], 220)
      }
    }
  }

  private stop = () => {
    for (const cancel of this.motion.values()) cancel()
  }

  private play(card: HTMLElement, frames: Keyframe[], duration: number, onEnd?: () => void) {
    this.motion.get(card)?.()
    const animation = card.animate(frames, { duration, easing: onEnd ? 'linear' : settle })
    const cancel = () => {
      this.motion.delete(card)
      animation.cancel()
      onEnd?.()
    }
    this.motion.set(card, cancel)
    void animation.finished.then(cancel, () => {})
  }

  private fly(id: string, source: CardPosition, target: CardPosition, viewport: DOMRect) {
    const ghost = source.card.cloneNode(true) as HTMLElement
    this.motion.get(source.card)?.()
    const from = source.rect
    const dx = target.rect.left - from.left
    const dy = target.rect.top - from.top
    const overlay = document.createElement('div')
    overlay.className = 'task-board-motion-overlay'
    overlay.setAttribute('aria-hidden', 'true')
    overlay.inert = true
    Object.assign(overlay.style, {
      left: `${viewport.left}px`, top: `${viewport.top}px`,
      width: `${viewport.width}px`, height: `${viewport.height}px`,
    })
    Object.assign(ghost.style, {
      position: 'absolute', margin: '0',
      left: `${from.left - viewport.left}px`, top: `${from.top - viewport.top}px`,
      width: `${from.width}px`, height: `${from.height}px`,
    })
    ghost.removeAttribute('data-board-task-id')
    ghost.removeAttribute('data-dragging')
    overlay.append(ghost)
    document.body.append(overlay)
    const duration = 430
    this.play(target.card, [{ opacity: 0 }, { opacity: 0 }], duration)
    this.flights.set(id, ghost)
    this.play(ghost, [
      { transform: 'translate(0, 0)', boxShadow: '0 0 0 transparent' },
      { transform: `translate(${dx * .12}px, ${dy * .12 - 12}px) scale(1.025)`, boxShadow: 'var(--elev-raised)', offset: .23 },
      { transform: `translate(${dx * .83}px, ${dy * .83 - 11}px) scale(1.015)`, boxShadow: 'var(--elev-raised)', offset: .72, easing: settle },
      { transform: `translate(${dx}px, ${dy}px) scale(${target.rect.width / from.width}, ${target.rect.height / from.height})`, boxShadow: '0 0 0 transparent' },
    ], duration, () => {
      this.motion.get(target.card)?.()
      this.flights.delete(id)
      overlay.remove()
    })
  }

  render() {
    return <div ref={this.board} className={this.props.className} onScrollCapture={this.stop}>{this.props.children}</div>
  }
}
